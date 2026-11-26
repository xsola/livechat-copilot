import { candidateFrom, candidateFromExample, completeCandidateRule, composerElements, visionSample, type Candidate } from './candidates';
import { captureRect, visibleBounds } from './viewport';
import { send } from '../../platform/messages';
import { PagePanel, type ReviewFeedback } from '../page-panel';
import type { PageSettings } from '../../platform/config';
import { testRule } from '../dom';
import type { BodyVerdict } from '../../models/tasks';

function bodyFeedback(verdict?: BodyVerdict) {
  if (verdict === 'clean') return '正文样本未见昵称、徽章或时间戳混入。';
  if (verdict === 'mixed-metadata') return '正文可能混入昵称、徽章或时间戳，请重新核对。';
  return verdict === 'uncertain' ? '模型无法确认样本是否只包含正文。' : '模型未单独判断正文。';
}

function resizeSelection(selected: Element, cursor: Element | undefined, grow: boolean, previousLevel?: Element) {
  const current = visibleBounds(selected);
  const fitsInside = (outer: DOMRect, inner: DOMRect) => inner.width > 0 && inner.height > 0 &&
    outer.left <= inner.left + 1 && outer.top <= inner.top + 1 && outer.right >= inner.right - 1 &&
    outer.bottom >= inner.bottom - 1 && (outer.width > inner.width + 1 || outer.height > inner.height + 1);
  if (grow) {
    for (let node = selected.parentElement; node && node !== selected.ownerDocument.body; node = node.parentElement) {
      if (fitsInside(visibleBounds(node), current)) return node;
    }
  } else if (previousLevel && selected.contains(previousLevel) && fitsInside(current, visibleBounds(previousLevel))) {
    return previousLevel;
  } else if (cursor && selected.contains(cursor)) {
    const path: Element[] = [];
    for (let node: Element | null = cursor; node && node !== selected; node = node.parentElement) path.unshift(node);
    return path.find(node => fitsInside(current, visibleBounds(node))) ?? selected;
  }
  return selected;
}

export class Picker {
  private controller?: AbortController;
  private selected?: Element;
  private cursor?: Element;
  private showing?: Candidate;
  private searching = false;
  private searchEpoch = 0;
  private readonly reviews = new Map<string, ReviewFeedback>();

  constructor(
    private readonly panel: PagePanel,
    private readonly page: URL,
    private readonly frame: URL,
    private readonly settings: () => PageSettings | undefined,
    private readonly save: (candidate: Candidate) => Promise<void>,
  ) {}

  suggest(candidate: Candidate) {
    if (!this.searching) return false;
    this.preview(candidate, {});
    return true;
  }

  showSuggested(candidate: Candidate) {
    this.preview(candidate, { localOnly: true });
  }

  beginSearch() {
    this.endListeners();
    this.showing = undefined;
    this.searching = true;
    this.searchEpoch++;
    this.panel.highlight();
    this.panel.show('正在识别弹幕区', '识别完成后会标出弹幕区。你可以随时取消。');
    this.panel.setBusy(true);
    this.searchProgress('正在检查已有规则…');
    this.panel.button('取消识别', () => this.close());
  }

  searchProgress(text: string) {
    if (this.searching) this.panel.note(text);
  }

  isSearching() {
    return this.searching;
  }

  noCandidate(reason = '没有找到能稳定提取弹幕的区域。', unresolved?: Element, review?: ReviewFeedback) {
    if (!this.searching) return;
    this.searching = false;
    if (unresolved?.isConnected) {
      this.panel.highlight(unresolved);
      this.panel.showAnchored('找到疑似弹幕列表', '暂时无法可靠分离正文。可从工具栏打开「手动选择弹幕区」，再点一条弹幕正文作为示例。');
    } else {
      this.panel.highlight();
      this.panel.show('未找到弹幕区', reason + '可从工具栏打开「手动选择弹幕区」。');
    }
    if (review) this.panel.showReview(review);
    this.panel.button('关闭', () => this.close());
  }

  async locate(candidates: Candidate[], unresolved?: Element) {
    const attempt = this.searchEpoch;
    const settings = this.settings();
    if (!settings?.imageInput || !settings.autoVision || !settings.modelConfigured) {
      this.noCandidate(undefined, unresolved);
      return;
    }
    const candidatesById = new Map<string, Candidate>();
    const choices = candidates.slice(0, 4).flatMap(candidate => {
      const options = [candidate];
      if (candidate.alternativeBody) options.push({ ...candidate, ...candidate.alternativeBody, rule: {
        ...candidate.alternativeBody.rule, composer: candidate.rule.composer, sendButton: candidate.rule.sendButton,
      } });
      if (candidate.alternativeComposer) options.push({ ...candidate, rule: candidate.alternativeComposer });
      return options;
    });
    const visible = choices.flatMap(candidate => {
      try {
        const rect = captureRect(candidate.container);
        return [{ candidate, rect }];
      } catch { return []; }
    });
    if (!visible.length) {
      this.noCandidate(undefined, unresolved, { state: 'skipped', lines: [candidates.length
        ? '候选区域当前不可截图，可滚动到可见范围后重试。' : '没有找到可供截图核验的候选。'] });
      return;
    }
    this.searchProgress('正在让模型对照候选区域截图和弹幕样本…');
    try {
      await this.hideForCapture();
      if (!this.searching || this.searchEpoch !== attempt) return;
      const areas = [];
      for (const { candidate, rect } of visible) {
        if (!candidate.container.isConnected) continue;
        const editorRect = this.editorCrop(composerElements(candidate).editor);
        if (!editorRect && [...candidatesById.values()].some(previous => previous.container === candidate.container &&
          previous.rule.body === candidate.rule.body && previous.rule.bodyAfter?.anchor === candidate.rule.bodyAfter?.anchor)) continue;
        const id: string = 'area-' + (areas.length + 1);
        candidatesById.set(id, candidate);
        areas.push({ id, rect, editorRect, ...visionSample(candidate) });
        if (areas.length === 3) break;
      }
      if (!areas.length) {
        this.noCandidate(undefined, unresolved, { state: 'skipped', lines: ['候选区域已变化，未进行截图核验。'] });
        return;
      }
      const result = await send('locateChat', areas);
      if (!this.searching || this.searchEpoch !== attempt) return;
      const selected = result.candidateId ? candidatesById.get(result.candidateId) : undefined;
      const verified = selected && testRule(selected.container.ownerDocument, selected.rule, selected.container);
      if (selected?.container.isConnected && verified && !verified.rejected && verified.messages.length >= 2) {
        const excludeComposer = result.useComposer === false && areas.some(area => area.id === result.candidateId && area.editorRect);
        if (excludeComposer) selected.rule = { ...selected.rule, composer: undefined, sendButton: undefined };
        this.preview({ ...selected, messages: verified.messages }, { excludeComposer, located: {
          state: result.bodyVerdict === 'clean' ? 'done' : 'warning',
          lines: ['已用截图比对候选位置。', bodyFeedback(result.bodyVerdict)], reason: result.reason,
        } });
      }
      else this.noCandidate(undefined, unresolved, {
        state: 'warning', lines: ['模型或本地校验未能确认可用的弹幕候选。'], reason: result.reason,
      });
    } catch (error) {
      if (this.searchEpoch === attempt) this.noCandidate(undefined, unresolved, {
        state: 'skipped', lines: [error instanceof Error ? error.message : '截图核验失败。'],
      });
    } finally {
      this.panel.captureVisibility(true);
    }
  }

  showMatched(candidate: Candidate, source: string) {
    this.preview(candidate, { source });
  }

  start(body = false, initial?: Candidate) {
    this.endListeners();
    this.searching = false;
    const controller = this.controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const document = window.document;
    this.showing = undefined;
    this.selected = initial?.container;
    this.cursor = initial?.messages[0]?.node ?? initial?.container.firstElementChild ?? undefined;
    const expandedFrom: Element[] = [];
    this.panel.highlight(this.selected, Boolean(initial));
    const choose = () => { if (this.selected) this.choose(this.selected, body, Boolean(initial)); };
    if (initial) {
      this.panel.showAnchored('调整框选范围', '↑ 扩大可见区域，↓ 缩小可见区域。按 Enter 确认，按 Esc 关闭。');
      this.panel.button('确认调整', choose);
    } else {
      this.panel.showAside(body ? '点一条弹幕正文' : '手动选择弹幕区',
        body ? '在聊天里点击一条消息的文字，插件会从这条消息向外查找弹幕列表。'
          : '点击包含多条弹幕的列表。↑ 扩大选区，↓ 缩小选区，Esc 退出。');
      if (!body) this.panel.button('改为点一条弹幕正文', () => this.start(true));
    }
    this.panel.button('取消', () => this.close());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (this.panel.contains(event) && (!initial || event.key === 'Enter')) return;
      if (!this.selected || !['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') { choose(); return; }
      const previous = this.selected;
      if (initial) {
        const grow = event.key === 'ArrowUp';
        this.selected = resizeSelection(this.selected, this.cursor, grow, grow ? undefined : expandedFrom.pop());
        if (grow && this.selected !== previous) expandedFrom.push(previous);
      } else if (event.key === 'ArrowUp' && this.selected.parentElement && this.selected.parentElement !== document.documentElement) {
        this.selected = this.selected.parentElement;
      } else if (event.key === 'ArrowDown' && this.cursor) {
        let descendant: Element | null = this.cursor;
        while (descendant?.parentElement && descendant.parentElement !== this.selected) descendant = descendant.parentElement;
        if (descendant?.parentElement === this.selected) this.selected = descendant;
      }
      this.panel.highlight(this.selected, Boolean(initial));
      if (initial) {
        const { width, height } = visibleBounds(this.selected);
        const change = event.key === 'ArrowUp' ? '扩大' : '缩小';
        this.panel.note(this.selected === previous ? '这个方向没有可调整的层级。' :
          '已' + change + '一层（' + Math.round(width) + ' × ' + Math.round(height) + ' 像素）。');
      }
    };
    document.addEventListener('keydown', handleKey, options);
    if (window.top !== window) window.top?.document.addEventListener('keydown', handleKey, options);
    if (initial) return;
    document.addEventListener('mousemove', event => {
      if (this.panel.contains(event) || !(event.target instanceof Element)) return;
      if (this.cursor !== event.target) this.selected = this.cursor = event.target;
      this.panel.highlight(this.selected);
    }, options);
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

  private choose(node: Element, body: boolean, adjusted = false) {
    if (!node.isConnected) { this.panel.note('页面已变化，请重新选择。'); return; }
    const candidate = body ? candidateFromExample(document, node, this.page, this.frame)
      : candidateFrom(document, node, this.page, this.frame) ?? (adjusted ? undefined : candidateFromExample(document, node, this.page, this.frame));
    if (candidate) { this.preview(candidate, undefined, adjusted); return; }
    if (adjusted) {
      this.panel.note('当前框内没有提取到多条弹幕。请按 ↑ 或 ↓ 继续调整。');
      return;
    }
    this.endListeners();
    this.panel.highlight();
    this.panel.show('暂时无法用这个选区提取弹幕', '请点聊天消息中的文字，或手动选中包含多条消息的列表。');
    this.panel.button('点一条弹幕正文', () => this.start(true));
    this.panel.button('手动选整个弹幕区', () => this.start());
    this.panel.button('关闭', () => this.close());
  }

  private preview(candidate: Candidate, automatic?: { source?: string; located?: ReviewFeedback; excludeComposer?: boolean; localOnly?: boolean }, adjusted = false) {
    this.endListeners();
    this.searching = false;
    candidate = {
      ...candidate,
      rule: automatic?.excludeComposer ? candidate.rule : completeCandidateRule(document, candidate.container, candidate.rule),
    };
    this.showing = candidate;
    this.panel.highlight(candidate.container, Boolean(automatic) || adjusted);
    const { state, button } = composerElements(candidate);
    const controls = state === 'editable'
      ? (button ? '已找到输入区和发送按钮。' : '已找到可编辑输入区，发送按钮暂未识别。')
      : state === 'unavailable'
        ? '已找到输入区，当前无法编辑。'
        : '当前页面未识别到输入区。';
    const sources: Record<string, string> = { builtin: '内置规则', local: '你保存的规则', community: '社区规则', 'same-site': '同站直播间已保存的规则' };
    const { source, located } = automatic ?? {};
    if (automatic) {
      this.panel.showAnchored('已识别弹幕区', source
        ? '绿框标出弹幕区。当前使用' + (sources[source] ?? source) + '。' + controls
        : '请核对绿框位置。框住弹幕区就可以保存。' + controls);
    } else if (adjusted) {
      this.panel.showAnchored('核对弹幕样本', '下面是从调整后的绿框内读到的消息。' + controls, candidate);
    } else {
      this.panel.show('核对弹幕样本', '下面是从候选区读到的消息。样本正确就可保存。' + controls, candidate);
    }
    if (automatic || adjusted) {
      this.panel.button('调整框选范围', () => this.start(false, candidate));
      const { signal } = this.controller = new AbortController();
      const dismiss = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        this.close();
      };
      document.addEventListener('keydown', dismiss, { capture: true, signal });
      if (window.top !== window) window.top?.document.addEventListener('keydown', dismiss, { capture: true, signal });
    }
    const saveButton = source ? undefined : this.panel.button('保存并启用规则', button => {
        button.disabled = true;
        void this.save(candidate).then(() => this.close(), error => {
          button.disabled = false;
          this.panel.note(error instanceof Error ? error.message : '无法保存规则。');
        });
    });
    if (!automatic && !adjusted) {
      this.panel.button('点一条弹幕正文', () => this.start(true));
      this.panel.button('手动选整个弹幕区', () => this.start());
    }
    this.panel.button('关闭', () => this.close());
    if (!candidate.messages.length) {
      this.panel.showReview({ state: 'skipped', lines: ['暂无正文样本，先使用本地规则。'] });
      return;
    }
    if (located) { this.panel.showReview(located); return; }
    if (automatic?.localOnly) {
      this.panel.showReview({ state: 'skipped', lines: ['当前候选来自本地识别。可从工具栏重新发起自动识别。'] });
      return;
    }
    void this.queueReview(candidate, !automatic, saveButton);
  }

  private async queueReview(candidate: Candidate, showReason: boolean, saveButton?: HTMLButtonElement) {
    const settings = this.settings();
    if (!settings?.imageInput) {
      this.panel.showReview({ state: 'skipped', lines: [settings?.imageInput === false
        ? '当前模型不支持图片输入，已跳过截图核验。'
        : '模型的图片能力尚未确认，可在设置中测试。'] });
      return;
    }
    if (!settings.autoVision || !settings.modelConfigured) {
      this.panel.showReview({ state: 'skipped', lines: [settings.autoVision ? '请先在设置中授权模型服务。' : '截图核验未开启。'] });
      return;
    }
    const { state, button } = composerElements(candidate);
    const key = JSON.stringify([settings.revision, candidate.rule, state, Boolean(button)]);
    const existing = this.reviews.get(key);
    if (existing) { this.panel.showReview(existing, showReason); return; }
    let skipped = false;
    if (saveButton) saveButton.disabled = true;
    this.panel.showReview({ state: 'pending', lines: ['正在检查绿框位置和提取的正文样本。'] }, false, () => {
      skipped = true;
      if (saveButton) saveButton.disabled = false;
      this.panel.showReview({ state: 'skipped', lines: ['已跳过核验。请自行确认当前规则。'] });
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    if (this.showing !== candidate || skipped) return;
    const result = this.reviews.get(key) ?? await this.review(candidate, () => skipped);
    if (this.showing !== candidate || skipped) return;
    if (saveButton) saveButton.disabled = false;
    if (!result) return;
    if (result.state !== 'skipped') {
      this.reviews.set(key, result);
      if (this.reviews.size > 30) this.reviews.delete(this.reviews.keys().next().value!);
    }
    this.panel.showReview(result, showReason);
  }

  private async hideForCapture() {
    this.panel.captureVisibility(false);
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 160);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
    });
  }

  private editorCrop(editor: Element | null) {
    const draft = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement ? editor.value : editor?.textContent;
    return editor !== document.activeElement && !draft?.trim() ? this.optionalCrop(editor) : undefined;
  }

  private optionalCrop(element: Element | null) {
    if (!element) return;
    try { return captureRect(element); } catch { return undefined; }
  }

  private async review(candidate: Candidate, skipped: () => boolean): Promise<ReviewFeedback | undefined> {
    if (!candidate.container.isConnected || document.visibilityState !== 'visible') {
      return { state: 'skipped', lines: ['直播标签页当前不在前台，已跳过图像复核。'] };
    }
    try {
      const rect = captureRect(candidate.container);
      const { editor, button } = composerElements(candidate);
      await this.hideForCapture();
      if (this.showing !== candidate || skipped()) return;
      if (!candidate.container.isConnected || document.visibilityState !== 'visible') {
        return { state: 'skipped', lines: ['页面已变化或直播标签页当前不在前台。'] };
      }
      const editorRect = this.editorCrop(editor);
      const sendRect = editorRect ? this.optionalCrop(button) : undefined;
      const result = await send('verify', { rect, editorRect, sendRect, ...visionSample(candidate) });
      const prefix = { 'likely-chat': '可能是弹幕区', 'unlikely-chat': '可能选错了弹幕区', uncertain: '无法确定弹幕区' }[result.verdict];
      const composer = editorRect && result.composerVerdict && {
        'likely-composer': '发送区可能匹配',
        'unlikely-composer': '发送区可能不匹配',
        uncertain: '无法确定发送区',
      }[result.composerVerdict];
      const needsAttention = result.verdict !== 'likely-chat' || result.bodyVerdict !== 'clean' || result.composerVerdict === 'unlikely-composer';
      return { state: needsAttention ? 'warning' : 'done', lines: [prefix, bodyFeedback(result.bodyVerdict), ...(composer ? [composer] : [])], reason: result.reason };
    } catch (error) {
      return { state: 'skipped', lines: [error instanceof Error ? error.message : '自动图像复核失败。'] };
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
