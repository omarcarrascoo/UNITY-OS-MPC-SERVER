import { getRuntimeConfig } from '../../config.js';
import { scaffoldProject } from '../../git.js';

export async function initProject(type: string, name: string): Promise<void> {
  await scaffoldProject(type, name, getRuntimeConfig().workspaceDir);
}
