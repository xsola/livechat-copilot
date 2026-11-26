import { readFile } from 'node:fs/promises';
import { generateDraft } from '../src/agent/tasks/draft';
import { createTasks, type Meter } from '../src/models/tasks';
import { defaults } from '../src/platform/config';

async function main() {
  let buffer = '';
  const readKey = process.argv.includes('--stdin');
  if (readKey) {
    for await (const chunk of process.stdin) buffer += chunk;
  }
  const apiKey = (readKey ? buffer : process.env.DEEPSEEK_API_KEY)?.trim();
  if (!apiKey) throw new Error('Set DEEPSEEK_API_KEY in your process or pass the key through stdin with --stdin.');
  const settings = { ...defaults, model: { ...defaults.model, apiKey } };
  const meter: Meter = async (task, success, elapsed, usage) => {
    console.log(JSON.stringify({ task, success, elapsed, ...usage }));
  };
  const tasks = createTasks(meter);
  const items = [{ id: 'test-1', text: 'What a comeback!' }, { id: 'test-2', text: 'ナイス、最後の逆転よかった！' }];
  const translations = await tasks.translate(settings, items);
  if (translations.length !== items.length) throw new Error('Translation did not return both IDs.');
  console.log(JSON.stringify({ translatedItems: translations.length }));
  const profile = await tasks.roomProfile(settings, { title: '練習配信', streamer: 'サンプル', category: 'ゲーム' },
    ['今日も楽しみです', '逆転できたね', 'みんなお疲れ様', 'この武器は強い', '次の試合も頑張って']);
  if (!profile.language?.startsWith('ja')) throw new Error('The synthetic Japanese room was not identified as Japanese.');
  const draft = await generateDraft(tasks, settings, {
    room: { ...profile, replyLanguage: profile.language },
    messages: items.map(({ text }) => ({ text, observedAt: 0 })),
  }, '用自然的语气夸一下刚才那波翻盘');
  console.log(JSON.stringify({ replyLanguage: profile.language, draftValidated: Boolean(draft.backTranslation) }));
  const imageFile = process.env.DEEPSEEK_SMOKE_IMAGE;
  if (imageFile) {
    const image = await readFile(imageFile);
    if (image.length > 1_500_000) throw new Error('Use a synthetic PNG of at most 1.5 MB for vision smoke testing.');
    const result = await tasks.vision(settings, 'data:image/png;base64,' + image.toString('base64'), {
      html: '<div><p>Great comeback!</p><p>That final play was close.</p></div>',
    });
    console.log(JSON.stringify({ visionVerdict: result.verdict }));
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'DeepSeek smoke test failed.');
  process.exitCode = 1;
});
