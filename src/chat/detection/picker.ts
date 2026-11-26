import { candidateFrom, completeCandidateRule, composerElements, visionSample, type Candidate } from './candidates';
import { captureRect } from './viewport';
import { send } from '../../platform/messages';
import { PagePanel } from '../page-panel';
import type { PageSettings } from '../../platform/config';

export class Picker {
  private controller?: AbortController;
  private selected?: Element;
  private region?: Element;
  private cursor?: Element;
  private showing?: Candidate;
  private suppressed = false;
  private readonly reviews = new Map<string, string>();
  private reviewQueue = Promise.resolve();

  constructor(
    private readonly panel: PagePanel,
    private readonly page: URL,
    private readonly frame: URL,
    private readonly settings: () => PageSettings | undefined,
    private readonly save: (candidate: Candidate) => Promise<void>,
  ) {}

  suggest(candidate: Candidate) {
    if (this.suppressed || this.showing || this.controller) return false;
    this.preview(candidate);
    return true;
  }

  resumeSuggestions() {
    this.suppressed = false;
  }

  showMatched(candidate: Candidate, source: string) {
    this.preview(candidate, source);
  }

  start(body = false) {
    this.endListeners();
    const controller = this.controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const document = window.document;
    this.showing = undefined;
    this.selected = undefined;
    this.cursor = undefined;
    this.panel.show(body ? '选择一条消息正文' : '选择弹幕区域',
      '移动鼠标高亮元素，↑ 选父元素，↓ 选回下一级。点击选择，Esc 退出。');
    this.panel.button('取消', () => this.close());
    document.addEventListener('mousemove', event => {
      if (this.panel.contains(event) || !(event.target instanceof Element)) return;
      if (body && !this.region?.contains(event.target)) return;
      if (this.cursor !== event.target) this.selected = this.cursor = event.target;
      this.panel.highlight(this.selected);
    }, options);
    const handleKey = (event: KeyboardEvent) => {
      if (this.panel.contains(event)) return;
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (!this.selected || !['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') { this.choose(this.selected, body); return; }
      if (event.key === 'ArrowUp' && this.selected.parentElement &&
        (body ? this.selected.parentElement !== this.region : this.selected.parentElement !== document.documentElement)) {
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
      if (this.panel.contains(event) || !this.selected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('click', event => {
      if (this.panel.contains(event) || !this.selected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.choose(this.selected, body);
    }, options);
  }

  private choose(node: Element, body: boolean) {
    const region = body ? this.region : node;
    if (!region?.isConnected) { this.panel.note('页面已变化，请重新选择。'); return; }
    this.region = region;
    this.endListeners();
    const candidate = candidateFrom(document, region, this.page, this.frame, body ? node : undefined);
    if (candidate) { this.preview(candidate); return; }
    this.panel.highlight(region);
    this.panel.show('还没有提取到弹幕', '可选择一条消息的正文作为示例。如果选中了单条消息，请返回并选它们共同的容器。');
    this.panel.button('选择正文', () => this.start(true));
    this.panel.button('重新选区', () => this.start());
    this.panel.button('关闭', () => this.close());
  }

  private preview(candidate: Candidate, source?: string) {
    this.endListeners();
    candidate = {
      ...candidate,
      rule: completeCandidateRule(document, candidate.container, candidate.rule),
    };
    this.showing = candidate;
    this.region = candidate.container;
    this.panel.highlight(candidate.container);
    const { editor, button } = composerElements(candidate);
    const controls = editor ? (button ? '已找到输入区和发送按钮。' : '已找到输入区，发送按钮暂未识别。') : '暂未找到可用的输入区。';
    this.panel.show(source ? '已识别弹幕' : '确认弹幕区域',
      (source ? '当前规则来源：' + source + '。' : '确认后保存为本站的本地规则。') + controls, candidate);
    let saveButton: HTMLButtonElement | undefined;
    if (!source) {
      saveButton = this.panel.button('保存并启用规则', button => {
        button.disabled = true;
        void this.save(candidate).then(() => this.close(), error => {
          button.disabled = false;
          this.panel.note(error instanceof Error ? error.message : '无法保存规则。');
        });
      });
      this.panel.button('选择正文', () => this.start(true));
    }
    this.panel.button('重新选区', () => this.start());
    this.panel.button('关闭', () => this.close());
    if (!candidate.messages.length) {
      this.panel.note('暂无正文样本，先使用本地规则。');
      return;
    }
    const review = this.queueReview(candidate);
    if (saveButton && review) {
      const button = saveButton;
      button.disabled = true;
      void review.then(() => { button.disabled = false; });
    }
  }

  private queueReview(candidate: Candidate) {
    const settings = this.settings();
    if (!settings?.imageInput) {
      this.panel.note('当前模型不支持或未启用图片输入，已跳过图像复核。');
      return;
    }
    if (!settings.autoVision || !settings.modelConfigured) {
      this.panel.note(settings.autoVision ? '请先在设置中授权模型服务。' : '自动图像复核未开启。');
      return;
    }
    const key = JSON.stringify([settings.revision, candidate.rule]);
    const existing = this.reviews.get(key);
    if (existing) { this.panel.note(existing); return; }
    this.panel.note('正在自动复核候选规则…');
    this.reviewQueue = this.reviewQueue.then(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (this.showing !== candidate) return;
      const text = this.reviews.get(key) ?? await this.review(candidate);
      if (text) {
        if (!text.includes('截图权限') && !text.includes('不在前台')) {
          this.reviews.set(key, text);
          if (this.reviews.size > 30) this.reviews.delete(this.reviews.keys().next().value!);
        }
        if (this.showing === candidate) this.panel.note(text);
      }
    });
    return this.reviewQueue;
  }

  private async review(candidate: Candidate) {
    if (!candidate.container.isConnected || document.visibilityState !== 'visible') {
      return '直播标签页当前不在前台，已跳过图像复核。';
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
      this.panel.captureVisibility(false);
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 160);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
      });
      if (this.showing !== candidate || !candidate.container.isConnected) return;
      if (document.visibilityState !== 'visible') return '直播标签页当前不在前台，已跳过图像复核。';
      const editorRect = editor === document.activeElement || hasDraft() ? undefined : optionalCrop(editor);
      const sendRect = editorRect ? optionalCrop(button) : undefined;
      const result = await send('verify', { rect, editorRect, sendRect, ...visionSample(candidate) });
      const prefix = { 'likely-chat': '可能是弹幕区', 'unlikely-chat': '可能选错了弹幕区', uncertain: '无法确定弹幕区' }[result.verdict];
      const composer = result.composerVerdict && {
        'likely-composer': '发送区可能匹配',
        'unlikely-composer': '发送区可能不匹配',
        uncertain: '无法确定发送区',
      }[result.composerVerdict];
      return [prefix, composer, result.reason].filter(Boolean).join('。');
    } catch (error) {
      return error instanceof Error ? error.message : '自动图像复核失败。';
    } finally {
      this.panel.captureVisibility(true);
    }
  }

  private endListeners() {
    this.controller?.abort();
    this.controller = undefined;
  }

  close() {
    this.suppressed = true;
    this.showing = undefined;
    this.endListeners();
    this.panel.hide();
  }
}
