import { z } from 'zod';

const path = z.string().startsWith('/').max(250).optional();
const selector = z.string().trim().min(1).max(500);
export const hostName = z.string().max(253).regex(/^[a-z0-9.-]+$/i);

export const chatRule = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  version: z.number().int().positive(),
  host: hostName,
  pathPrefix: path,
  framePathPrefix: path,
  container: selector,
  message: selector,
  body: selector.optional(),
  ignore: selector.optional(),
  composer: selector.optional(),
  sendButton: selector.optional(),
});

export const ruleIndex = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(chatRule).max(250),
}).refine(({ rules }) => new Set(rules.map(({ id }) => id)).size === rules.length,
  'Rule IDs must be unique');

export type ChatRule = z.infer<typeof chatRule>;
export type RuleSource = 'local' | 'community' | 'builtin' | 'automatic';

export interface RuleMatch {
  rule: ChatRule;
  source: RuleSource;
  staged?: boolean;
}

export function ruleMatches(rule: ChatRule, page: URL, frame: URL) {
  return rule.host === page.hostname && page.hostname === frame.hostname &&
    (!rule.pathPrefix || page.pathname.startsWith(rule.pathPrefix)) &&
    (!rule.framePathPrefix || frame.pathname.startsWith(rule.framePathPrefix));
}
