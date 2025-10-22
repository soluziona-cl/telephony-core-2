import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Import services
import './services/ari-listener.js';
import './services/campaign-engine.js';
import './services/telephony-watcher.js';

console.log('🚀 Telephony Core System Started');
console.log('📡 ARI Listener: Active');
console.log('📊 Campaign Engine: Active');
console.log('👁️ Telephony Watcher: Active');
