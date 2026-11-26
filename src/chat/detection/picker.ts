import { candidateFrom, visionSample, type Candidate } from './candidates';
import { captureRect } from './viewport';
import { send } from '../../platform/messages';
import { PagePanel } from '../page-panel';

export class Picker {
  private controller?: AbortController;
  private selected?: Element;
  private region?: Element;
  private cursor?: Element;
  private showing?: Candidate;
  private suppressed = false;
  private reviewing = false;

  constructor(
    private readonly panel: PagePanel,
    private readonly page: URL,
    private readonly frame: URL,
    private readonly imageInput: () => boolean,
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

  private preview(candidate: Candidate) {
    this.endListeners();
    this.showing = candidate;
    this.region = candidate.container;
    this.panel.highlight(candidate.container);
    this.panel.show('确认弹幕区域', '检查下面几条消息。确认后将保存为本站的本地规则。', candidate);
    this.panel.button('保存并启用规则', button => {
      button.disabled = true;
      void this.save(candidate).then(() => this.close(), error => {
        button.disabled = false;
        this.panel.note(error instanceof Error ? error.message : '无法保存规则。');
      });
    });
    this.panel.button('选择正文', () => this.start(true));
    this.panel.button('重新选区', () => this.start());
    if (this.imageInput()) {
      this.panel.note('AI 复核会把候选区裁图和少量正文发送给你配置的模型。');
      this.panel.button('AI 复核一次', button => { void this.review(candidate, button); });
    }
    this.panel.button('关闭', () => this.close());
  }

  private async review(candidate: Candidate, button: HTMLButtonElement) {
    if (this.reviewing || this.showing !== candidate) return;
    this.reviewing = true;
    button.disabled = true;
    try {
      const rect = captureRect(candidate.container);
      this.panel.captureVisibility(false);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const result = await send('verify', { rect, ...visionSample(candidate) });
      if (this.showing === candidate) {
        const prefix = { 'likely-chat': '可能是弹幕区', 'unlikely-chat': '可能选错了区域', uncertain: '无法确定' }[result.verdict];
        this.panel.note(prefix + '。' + result.reason);
      }
    } catch (error) {
      if (this.showing === candidate) this.panel.note(error instanceof Error ? error.message : 'AI 复核失败。');
    } finally {
      this.panel.captureVisibility(true);
      this.reviewing = false;
      // The current preview stays one-shot. A newly selected candidate can be checked again.
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
