/**
 * Quintero Client Entry Point
 * Exports the domain function and bot name.
 */
import quinteroBot from './bot/index.js';
import * as tts from './bot/tts/messages.js';

export const domain = quinteroBot;
export const botName = 'quintero';

// Exported for testing/verification
export const initialGreeting = tts.askRut();

export { config } from './config.js';

