import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-omp-bridge');

export const paths = {
  appDir,
  cacheDir: appDir,
  configFile: join(appDir, 'config.json'),
  configFileYaml: join(appDir, 'config.yaml'),
  configFileYml: join(appDir, 'config.yml'),
  sessionsFile: join(appDir, 'sessions.json'),
  workspacesFile: join(appDir, 'workspaces.json'),
  processesFile: join(appDir, 'processes.json'),
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  secretsGetterScript: join(appDir, 'secrets-getter'),
  mediaDir: join(appDir, 'media'),
  ompSessionsDir: join(appDir, 'omp-sessions'),
  guestDir: join(appDir, 'guest'),
};
