import { builtins } from './builtin';
import { bilibiliBody, bilibiliHost } from '../chat/bilibili';
import { ruleMatches, type ChatRule, type RuleMatch } from './schema';

export interface CommunityRules {
  active: ChatRule[];
  staged: ChatRule[];
  rejected: Record<string, number>;
}

function mostSpecific(rules: ChatRule[]) {
  return rules.toSorted((a, b) =>
    ((b.pathPrefix?.length ?? 0) + (b.framePathPrefix?.length ?? 0)) -
    ((a.pathPrefix?.length ?? 0) + (a.framePathPrefix?.length ?? 0)));
}

export function resolveRules(page: URL, frame: URL, local: ChatRule[], community: CommunityRules): RuleMatch[] {
  const matching = (rules: ChatRule[]) => mostSpecific(rules.filter(rule => ruleMatches(rule, page, frame)));
  const ordered: RuleMatch[] = [
    ...matching(local.toReversed()).map(rule => ({ rule, source: 'local' as const })),
    ...local.filter(rule => rule.host === page.hostname && page.origin === frame.origin &&
      Boolean(rule.framePathPrefix) === (page.pathname !== frame.pathname) && !ruleMatches(rule, page, frame))
      .reverse().map(rule => ({ rule, source: 'local' as const, sameSiteFallback: true })),
    ...matching(community.staged).map(rule => ({ rule, source: 'community' as const, staged: true })),
    ...matching(community.active).map(rule => ({ rule, source: 'community' as const })),
    ...matching(builtins).map(rule => ({ rule, source: 'builtin' as const })),
  ];
  if (page.hostname !== bilibiliHost) return ordered;
  const loose = (match: RuleMatch) => match.source === 'local' && match.rule.body !== bilibiliBody;
  return [...ordered.filter(match => !loose(match)), ...ordered.filter(loose)];
}

export function stageRules(current: CommunityRules, incoming: ChatRule[]): CommunityRules {
  const ids = new Set(incoming.map(rule => rule.id));
  const active = current.active.filter(rule => ids.has(rule.id));
  const staged = incoming.filter(rule =>
    rule.version > (active.find(known => known.id === rule.id)?.version ?? 0) &&
    rule.version > (Object.hasOwn(current.rejected, rule.id) ? current.rejected[rule.id]! : 0));
  return { ...current, active, staged };
}

export function decideRule(current: CommunityRules, id: string, version: number, passed: boolean): CommunityRules {
  const candidate = current.staged.find(rule => rule.id === id && rule.version === version);
  if (!candidate) return current;
  const staged = current.staged.filter(rule => rule.id !== id);
  if (passed) {
    return { ...current, staged, active: [...current.active.filter(rule => rule.id !== id), candidate] };
  }
  return { ...current, staged, rejected: { ...current.rejected, [id]: version } };
}
