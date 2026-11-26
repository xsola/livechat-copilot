import { candidateFrom, candidateFromExample, completeCandidateRule, composerElements, visionSample, type Candidate } from './candidates';
import { captureRect } from './viewport';
import { send } from '../../platform/messages';
import { PagePanel } from '../page-panel';
import type { PageSettings } from '../../platform/config';

export class Picker {
  private controller?: AbortController;
  private selected?: Element;
  private cursor?: Element;
  private showing?: Candidate;
  private searching = false;
  private searchEpoch = 0;
  private readonly reviews = new Map<string, { text: string }>();

  constructor(
    private readonly panel: PagePanel,
    private readonly page: URL,
    private readonly frame: URL,
    private readonly settings: () => PageSettings | undefined,
    private readonly save: (candidate: Candidate) => Promise<void>,
  ) {}

  suggest(candidate: Candidate) {
    if (!this.searching) return false;
    this.preview(candidate);
    return true;
  }

  beginSearch() {
    this.endListeners();
    this.showing = undefined;
    this.searching = true;
    this.searchEpoch++;
    this.panel.highlight();
    this.panel.show('正在识别弹幕区', '正在检查页面结构和重复出现的弹幕。');
    this.panel.button('关闭', () => this.close());
  }

  isSearching() {
    return this.searching;
  }

  noCandidate(reason = '没有找到能稳定提取弹幕的区域。') {
    if (!this.searching) return;
    this.searching = false;
    this.panel.highlight();
    this.panel.show('未找到弹幕区', reason + '可以点一条确实来自聊天的消息，让插件继续查找。');
    this.panel.button('点一条弹幕正文', () => this.start(true));
    this.panel.button('手动选整个弹幕区', () => this.start());
    this.panel.button('关闭', () => this.close());
  }

  async locate(candidates: Candidate[]) {
    const attempt = this.searchEpoch;
    const settings = this.settings();
    if (!settings?.imageInput || !settings.autoVision || !settings.modelConfigured) {
      this.noCandidate();
      return;
    }
    const candidatesById = new Map<string, Candidate>();
    const areas = candidates.slice(0, 4).flatMap(candidate => {
      try {
        const id = 'area-' + (candidatesById.size + 1);
        const rect = captureRect(candidate.container);
        candidatesById.set(id, candidate);
        return [{ id, rect, ...visionSample(candidate) }];
      } catch { return []; }
    }).slice(0, 3);
    if (!areas.length) { this.noCandidate(); return; }
    this.panel.note('正在让模型对照候选区域截图和弹幕样本…');
    try {
      await this.hideForCapture();
      if (!this.searching || this.searchEpoch !== attempt) return;
      const result = await send('locateChat', areas);
      if (!this.searching || this.searchEpoch !== attempt) return;
      const selected = result.candidateId ? candidatesById.get(result.candidateId) : undefined;
      if (selected) this.preview(selected, undefined, '模型选出的候选区。' + result.reason);
      else this.noCandidate();
    } catch (error) {
      if (this.searchEpoch === attempt) this.noCandidate(error instanceof Error ? error.message + ' ' : undefined);
    } finally {
      this.panel.captureVisibility(true);
    }
  }

  showMatched(candidate: Candidate, source: string) {
    this.preview(candidate, source);
  }

  start(body = false) {
    this.endListeners();
    this.searching = false;
    const controller = this.controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const document = window.document;
    this.showing = undefined;
    this.selected = undefined;
    this.cursor = undefined;
    this.panel.showPicker(body ? '点一条弹幕正文' : '手动选择弹幕区',
      body ? '在聊天里点击一条消息的文字，插件会从这条消息向外查找弹幕列表。'
        : '点击包含多条弹幕的列表。↑ 扩大选区，↓ 缩小选区，Esc 退出。');
    if (!body) this.panel.button('改为点一条弹幕正文', () => this.start(true));
    this.panel.button('取消', () => this.close());
    document.addEventListener('mousemove', event => {
      if (this.panel.contains(event) || !(event.target instanceof Element)) return;
      if (this.cursor !== event.target) this.selected = this.cursor = event.target;
      this.panel.highlight(this.selected);
    }, options);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (this.panel.contains(event)) return;
      if (!this.selected || !['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') { this.choose(this.selected, body); return; }
      if (event.key === 'ArrowUp' && this.selected.parentElement && this.selected.parentElement !== document.documentElement) {
        this.selected = this.selected.parentElement;
      } else if (event.key === 'ArrowDown' && this.cursor) {
        let descendant: Element | null = this.cursor;
        while (descendant?.parentElement && descendant.parentElement !== this.selected) descendant = descendant.parentElement;
        if (descendant?.parentElement === this.selected) this.selected = descendant;
      }
      this.panel.highlight(this.selected);
    };
    document.addEventListener('keydown', handleKey, options);
    if (window.top !== window) window.top?.document.addEventListener('keydown', handleKey, options);
    document.addEventListener('pointerdown', event => {
      if (this.panel.contains(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('click', event => {
      if (this.panel.contains(event) || !(event.target instanceof Element)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.choose(this.cursor === event.target ? this.selected ?? event.target : event.target, body);
    }, options);
  }

  private choose(node: Element, body: boolean) {
    if (!node.isConnected) { this.panel.note('页面已变化，请重新选择。'); return; }
    this.endListeners();
    const candidate = body ? candidateFromExample(document, node, this.page, this.frame)
      : candidateFrom(document, node, this.page, this.frame) ?? candidateFromExample(document, node, this.page, this.frame);
    if (candidate) { this.preview(candidate); return; }
    this.panel.highlight();
    this.panel.show('暂时无法用这个选区提取弹幕', '请点聊天消息中的文字，或手动选中包含多条消息的列表。');
    this.panel.button('点一条弹幕正文', () => this.start(true));
    this.panel.button('手动选整个弹幕区', () => this.start());
    this.panel.button('关闭', () => this.close());
  }

  private preview(candidate: Candidate, source?: string, locatedNote?: string) {
    this.endListeners();
    this.searching = false;
    candidate = {
      ...candidate,
      rule: completeCandidateRule(document, candidate.container, candidate.rule),
    };
    this.showing = candidate;
    this.panel.highlight(candidate.container);
    const { state, button } = composerElements(candidate);
    const controls = state === 'editable'
      ? (button ? '已找到输入区和发送按钮。' : '已找到可编辑输入区，发送按钮暂未识别。')
      : state === 'unavailable'
        ? '已找到输入区，当前无法编辑。'
        : '当前页面未识别到输入区。';
    const sources: Record<string, string> = { builtin: '内置规则', local: '你保存的规则', community: '社区规则' };
    this.panel.show(source ? '已识别弹幕' : '核对弹幕样本',
      (source ? '当前使用' + (sources[source] ?? source) + '。' : '下面是从候选区读到的消息。样本正确就可保存。') + controls, candidate);
    if (!source) {
      this.panel.button('保存并启用规则', button => {
        button.disabled = true;
        void this.save(candidate).then(() => this.close(), error => {
          button.disabled = false;
          this.panel.note(error instanceof Error ? error.message : '无法保存规则。');
        });
      });
    }
    this.panel.button('点一条弹幕正文', () => this.start(true));
    this.panel.button('手动选整个弹幕区', () => this.start());
    this.panel.button('关闭', () => this.close());
    if (!candidate.messages.length) {
      this.panel.note('暂无正文样本，先使用本地规则。');
      return;
    }
    if (locatedNote) { this.panel.note(locatedNote); return; }
    void this.queueReview(candidate);
  }

  private queueReview(candidate: Candidate) {
    const settings = this.settings();
    if (!settings?.imageInput) {
      this.panel.note(settings?.imageInput === false
        ? '当前模型不支持图片输入，已跳过截图核验。'
        : '模型的图片能力尚未确认，可在设置中测试。');
      return;
    }
    if (!settings.autoVision || !settings.modelConfigured) {
      this.panel.note(settings.autoVision ? '请先在设置中授权模型服务。' : '截图核验未开启。');
      return;
    }
    const { state, button } = composerElements(candidate);
    const key = JSON.stringify([settings.revision, candidate.rule, state, Boolean(button)]);
    const existing = this.reviews.get(key);
    if (existing) { this.panel.note(existing.text); return Promise.resolve(existing); }
    this.panel.note('正在自动复核候选规则…');
    return (async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (this.showing !== candidate) return;
      const result = this.reviews.get(key) ?? await this.review(candidate);
      if (result) {
        if (!result.text.includes('截图权限') && !result.text.includes('不在前台')) {
          this.reviews.set(key, result);
          if (this.reviews.size > 30) this.reviews.delete(this.reviews.keys().next().value!);
        }
        if (this.showing === candidate) this.panel.note(result.text);
      }
      return result;
    })();
  }

  private async hideForCapture() {
    this.panel.captureVisibility(false);
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 160);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
    });
  }

  private async review(candidate: Candidate) {
    if (!candidate.container.isConnected || document.visibilityState !== 'visible') {
      return { text: '直播标签页当前不在前台，已跳过图像复核。' };
    }
    try {
      const rect = captureRect(candidate.container);
      const { editor, button } = composerElements(candidate);
      const hasDraft = () => Boolean((editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
        ? editor.value : editor?.textContent)?.trim());
      const optionalCrop = (element: Element | null) => {
        if (!element) return;
        try { return captureRect(element); } catch { return undefined; }
      };
      await this.hideForCapture();
      if (this.showing !== candidate || !candidate.container.isConnected) return;
      if (document.visibilityState !== 'visible') return { text: '直播标签页当前不在前台，已跳过图像复核。' };
      const editorRect = editor === document.activeElement || hasDraft() ? undefined : optionalCrop(editor);
      const sendRect = editorRect ? optionalCrop(button) : undefined;
      const result = await send('verify', { rect, editorRect, sendRect, ...visionSample(candidate) });
      const prefix = { 'likely-chat': '可能是弹幕区', 'unlikely-chat': '可能选错了弹幕区', uncertain: '无法确定弹幕区' }[result.verdict];
      const composer = editorRect && result.composerVerdict && {
        'likely-composer': '发送区可能匹配',
        'unlikely-composer': '发送区可能不匹配',
        uncertain: '无法确定发送区',
      }[result.composerVerdict];
      const rejected = result.verdict === 'unlikely-chat';
      return { text: [prefix, composer, result.reason, rejected ? '建议点一条实际弹幕重新识别。' : ''].filter(Boolean).join('。') };
    } catch (error) {
      return { text: error instanceof Error ? error.message : '自动图像复核失败。' };
    } finally {
      this.panel.captureVisibility(true);
    }
  }

  private endListeners() {
    this.controller?.abort();
    this.controller = undefined;
  }

  close() {
    this.searching = false;
    this.showing = undefined;
    this.endListeners();
    this.panel.hide();
  }
}
