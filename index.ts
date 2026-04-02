import { Client, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import { getRuntimeConfig, WORKSPACE_DIR } from './src/config.js';
import { RuntimeState } from './src/runtime/state.js';
import { registerDiscordHandlers } from './src/transports/discord/register-handlers.js';
import { startUnityHttpServer } from './src/transports/http/server.js';

const config = getRuntimeConfig();
const runtime = new RuntimeState();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

console.log('BOOT DEBUG', {
  cwd: process.cwd(),
  workspaceDir: WORKSPACE_DIR,
  githubRepo: config.githubRepo,
  targetRepoPath: runtime.getActiveProject().repoPath,
});

registerDiscordHandlers(client, runtime);
startUnityHttpServer(runtime);

client.login(config.discordToken);
console.log('🤖 Jarvis Architect listening on Discord...');
