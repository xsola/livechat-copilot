import { hostPattern, parseRegistry } from '../platform/config';
import { readJson } from '../platform/json';
import { editState, readState, type State } from '../platform/store';
import { ruleIndex } from './schema';
import { stageRules } from './resolver';

export function summarizeRules(state: State) {
  return {
    local: state.localRules.toReversed().map(rule => ({ rule, addedAt: state.localRuleAddedAt[rule.id] ?? null })),
    active: state.community.active.length,
    staged: state.community.staged.length,
  };
}

export async function syncRegistry() {
  const source = (await readState()).settings.registryUrl;
  if (!source) throw new Error('Set a community registry URL first.');
  const url = parseRegistry(source);
  if (!await chrome.permissions.contains({ origins: [hostPattern(url)] })) {
    throw new Error('Grant access to the community registry in Settings.');
  }
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
  }).catch(() => { throw new Error('The community registry could not be reached.'); });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Community registry returned HTTP ' + response.status + '.');
  }
  const update = ruleIndex.safeParse(await readJson(response, 256_000).catch(() => undefined));
  if (!update.success) throw new Error('Invalid community index. Existing rules are still in use.');
  return editState(state => {
    if (state.settings.registryUrl !== source) throw new Error('The registry URL changed during the update.');
    const community = stageRules(state.community, update.data.rules);
    return { changes: { community }, result: summarizeRules({ ...state, community }) };
  });
}
