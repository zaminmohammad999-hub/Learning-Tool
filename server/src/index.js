import { createApp } from './app.js';
import { config } from './config.js';
import { applyRetention } from './services/data.js';
import { startAutomation } from './services/automation.js';

const app = createApp();
try {
  const r = applyRetention('retention-on-startup');
  if (r.deleted) console.log(`Retention policy removed ${r.deleted} old transcript(s).`);
} catch (err) {
  console.error('Retention check failed:', err.message);
}

app.listen(config.port, config.host, () => {
  startAutomation();
  console.log(`\nLearning Studio API on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  console.log(`Claude API key: ${config.anthropicKeyPresent ? 'configured (enable AI in Settings)' : 'not set — AI features disabled, core tracking works'}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.warn('WARNING: HOST is not localhost — private transcripts may be reachable on your network.');
});
