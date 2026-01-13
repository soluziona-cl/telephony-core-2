import { log as fallbackLog } from '../../../../lib/logger.js';

export class EngineRunner {
    constructor(modules, config = {}, logger = null) {
        // Policies
        this.silencePolicy = modules.silencePolicy;
        this.holdPolicy = modules.holdPolicy;
        this.terminationPolicy = modules.terminationPolicy;

        // ARI modules
        this.playback = modules.playback;
        this.recording = modules.recording;
        this.channelControl = modules.channelControl;

        // Core modules
        this.phaseManager = modules.phaseManager;

        // Configuration
        this.maxTurns = config.maxTurns || 20;
        this.PHASES = config.PHASES || {};

        // Logger
        this.logger = logger || {
            info: (msg) => fallbackLog('info', msg),
            warn: (msg) => fallbackLog('warn', msg),
            error: (msg) => fallbackLog('error', msg),
            debug: (msg) => fallbackLog('debug', msg),
            logTurn: (n) => fallbackLog('info', `Turn ${n}`),
            logSilence: (c, m) => fallbackLog('warn', `Silence ${c}/${m}`)
        };

        // OpenAI client (passed per session)
        this.openaiClient = null;
    }

    /**
     * Main engine loop - orchestrates all modules
     */
    async runLoop(session, channel, openaiClient, domainProcessor, conversationState, audioState, businessState) {
        this.openaiClient = openaiClient;
        let turnNumber = 0;

        this.logger.info(`🔄 [ENGINE] Starting main loop for ${session.linkedId}`);

        while (session.active && !session.terminated && turnNumber < this.maxTurns) {
            turnNumber++;
            this.logger.logTurn(turnNumber);

            // Guard: Check if session was terminated externally
            if (session.terminated) {
                this.logger.debug('[ENGINE] Session terminated externally, exiting loop');
                break;
            }

            // Guard: Check if channel is still alive
            const channelAlive = await this.channelControl.isAlive();
            if (!channelAlive) {
                this.logger.warn('[ENGINE] Channel is down, terminating session');
                session.terminate();
                break;
            }

            try {
                // Determine current phase (legacy compatibility)
                const currentPhase = businessState.rutPhase || session.currentPhase;

                // ========================================
                // 1. HOLD POLICY: Check if should enter HOLD
                // ========================================
                if (this.holdPolicy.shouldEnter(session, currentPhase, this.PHASES)) {
                    await this.holdPolicy.enter(session, this.channelControl);
                }

                // ========================================
                // 2. RECORDING: Capture user input
                // ========================================
                // Check if we should skip silent phases if phase manager says so
                // But for now, we rely on recording timeout or domain skip logic (which is simpler)
                // In modular V2 we might check phaseManager.requiresInput(currentPhase) before recording

                const recordResult = await this.recording.recordUserTurn(channel, turnNumber);

                // ========================================
                // 3. SILENCE POLICY: Evaluate if no voice detected
                // ========================================
                if (!recordResult.ok) {
                    const voiceDetected = false;
                    const silenceResult = this.silencePolicy.evaluate(session, voiceDetected);

                    this.logger.debug(`[ENGINE] Silence evaluation: ${JSON.stringify(silenceResult)}`);

                    // Handle silence actions
                    if (silenceResult.action === 'goodbye') {
                        // Max silences reached - end call gracefully
                        await this.terminationPolicy.finalize(
                            session,
                            this.channelControl,
                            this.playback,
                            silenceResult.message || 'Parece que no hay respuesta. Hasta luego.'
                        );
                        break;
                    } else if (silenceResult.action === 'prompt') {
                        this.logger.info('[ENGINE] Silence detected, domain should prompt user');
                    }

                    // Continue to next turn
                    continue;
                }

                // ========================================
                // 4. HOLD POLICY: Exit HOLD if voice detected
                // ========================================
                if (this.holdPolicy.shouldExit(session, true)) {
                    await this.holdPolicy.exit(session, this.channelControl);
                }

                // Mark voice detected in session
                session.markVoiceDetected();
                session.incrementTurn();
                audioState.hasSpeech = true;
                audioState.successfulTurns++;

                // ========================================
                // 5. DOMAIN PROCESSING: Process user input
                // ========================================
                const domainResult = await domainProcessor(recordResult, session, conversationState, audioState, businessState);

                // Guard: Check if session was terminated during processing
                if (session.terminated || !conversationState.active) {
                    this.logger.info('[ENGINE] Session terminated during domain processing');
                    break;
                }

                // ========================================
                // 6. PLAYBACK: Play domain response
                // ========================================
                if (domainResult.responseFile) {
                    const playbackOptions = {
                        bargeIn: !domainResult.critical && !businessState.disableBargeIn
                    };

                    const playbackResult = await this.playback.playWithBargeIn(
                        channel,
                        domainResult.responseFile,
                        openaiClient,
                        playbackOptions
                    );

                    if (playbackResult.reason === 'failed' || playbackResult.reason === 'error') {
                        this.logger.warn(`⚠️ [ENGINE] Playback error (${playbackResult.reason}), continuing`);
                    }
                }

                // Guard: Check if session is still active after playback
                if (!conversationState.active || session.terminated) {
                    this.logger.info('[ENGINE] Session terminated during playback');
                    break;
                }

                // ========================================
                // 7. GOODBYE POLICY: Check for goodbye
                // ========================================
                const assistantResponse = domainResult.assistantResponse || openaiClient.lastAssistantResponse || '';

                if (this.terminationPolicy.shouldEnd(assistantResponse)) {
                    this.logger.info(`[ENGINE] Goodbye detected in response: "${assistantResponse.substring(0, 50)}..."`);

                    // Wait for audio to complete
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Hangup gracefully
                    await this.channelControl.hangup();
                    session.terminate();
                    break;
                }

                // Update session phase
                if (domainResult.nextPhase) {
                    // Use PhaseManager if available, otherwise manual update
                    if (this.phaseManager) {
                        this.phaseManager.transition(session, domainResult.nextPhase, { reason: 'domain_result' });
                    } else {
                        session.currentPhase = domainResult.nextPhase;
                    }
                }

            } catch (err) {
                this.logger.error(`❌ [ENGINE] Error in turn ${turnNumber}: ${err.message}`);
                this.logger.error(`[ENGINE] Stack: ${err.stack}`);

                // Decide whether to continue or abort
                if (err.message && err.message.includes('Channel not found')) {
                    this.logger.warn('[ENGINE] Channel lost, terminating session');
                    session.terminate();
                    break;
                }

                // For other errors, continue to next turn
                this.logger.warn('[ENGINE] Continuing to next turn after error');
            }
        }

        // ========================================
        // LOOP EXIT
        // ========================================
        if (turnNumber >= this.maxTurns) {
            this.logger.warn(`⏰ [ENGINE] Max turns (${this.maxTurns}) reached`);
            await this.terminationPolicy.terminate(session, this.channelControl, 'max_turns');
        }

        this.logger.info(`🔚 [ENGINE] Loop ended: ${session.linkedId} (${turnNumber} turns, ${audioState.successfulTurns} successful)`);
    }

    async runDomainLoop(session, channel, openaiClient, domainHandler) {
        let turnNumber = 0;

        while (session.active && !session.terminated && turnNumber < this.maxTurns) {
            turnNumber++;
            this.logger.logTurn(turnNumber);

            if (this.holdPolicy.shouldEnter(session, session.currentPhase, this.PHASES)) {
                await this.holdPolicy.enter(session, this.channelControl);
            }

            const recordResult = await this.recording.recordUserTurn(channel, turnNumber);

            if (!recordResult.ok) {
                const silenceResult = this.silencePolicy.evaluate(session, false);
                if (silenceResult.action === 'goodbye') {
                    await this.terminationPolicy.finalize(session, this.channelControl, this.playback, silenceResult.message);
                    break;
                }
                continue;
            }

            if (this.holdPolicy.shouldExit(session, true)) {
                await this.holdPolicy.exit(session, this.channelControl);
            }

            const domainResponse = await domainHandler.process(recordResult.path, session);

            if (domainResponse.ttsFile) {
                await this.playback.playWithBargeIn(channel, domainResponse.ttsFile, openaiClient, {
                    bargeIn: !domainResponse.critical
                });
            }

            if (domainResponse.shouldHangup || this.terminationPolicy.shouldEnd(domainResponse.text)) {
                await this.terminationPolicy.finalize(session, this.channelControl, this.playback, null);
                break;
            }

            // Use PhaseManager
            if (this.phaseManager) {
                this.phaseManager.transition(session, domainResponse.nextPhase, { reason: 'domain_loop' });
            } else {
                session.currentPhase = domainResponse.nextPhase;
            }
        }
    }
}
