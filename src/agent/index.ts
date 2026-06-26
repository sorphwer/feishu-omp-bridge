export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { OmpAdapter } from './omp/adapter';
export {
  getAuthenticatedProviders,
  getDefaultRoleModel,
  setAuthenticatedProviders,
  setModelCatalog,
  setModelRoles,
  roleModels,
  type OmpModelInfo,
} from './omp/model-catalog';
