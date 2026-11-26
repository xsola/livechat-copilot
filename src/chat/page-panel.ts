import type { Candidate } from './detection/candidates';

const styles = [
  ':host{all:initial}',
  '.panel{position:fixed;right:12px;top:12px;z-index:2147483647;box-sizing:border-box;width:min(342px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:13px;background:#fff;color:#1c2331;border:1px solid #b4c1d7;border-radius:9px;box-shadow:0 4px 18px #0003;font:13px/1.45 system-ui,sans-serif}',
  '.panel.bottom-left{left:12px;right:auto;top:auto;bottom:12px}',
  '.hover{position:fixed;pointer-events:none;z-index:2147483646;outline:2px solid #1761df;background:#3187ff26;box-sizing:border-box}',
  '.hover.detected{outline:3px solid #16a34a;outline-offset:-3px;background:transparent;box-shadow:inset 0 0 0 4px #fffc}',
  'strong{display:block;font-size:14px}p{margin:7px 0}ul{margin:7px 0;padding-left:19px}li{overflow-wrap:anywhere}',
  'button,input{font:inherit;margin:4px 5px 0 0;padding:4px 7px;border:1px solid #5686c8;border-radius:5px;background:#f2f7ff;color:#192943}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #2164c4}',
].join('\n');

export class PagePanel {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly outline: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly document: Document) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-livechat-copilot', '');
    this.host.setAttribute('data-lcc-kind', 'panel');
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.outline = document.createElement('div');
    this.outline.className = 'hover';
    this.outline.hidden = true;
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'LiveChat Copilot');
    this.panel.hidden = true;
    this.status = document.createElement('p');
    this.status.setAttribute('role', 'status');
    this.root.append(style, this.outline, this.panel);
    document.documentElement.append(this.host);
  }

  contains(event: Event) {
    return event.composedPath().includes(this.host);
  }

  highlight(node?: Element, detected = false) {
    this.outline.hidden = !node;
    this.outline.classList.toggle('detected', detected);
    if (!node) return;
    const { x, y, width, height } = node.getBoundingClientRect();
    Object.assign(this.outline.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
  }

  show(title: string, description: string, candidate?: Candidate) {
    this.panel.classList.remove('bottom-left');
    this.panel.hidden = false;
    const heading = this.document.createElement('strong');
    heading.textContent = title;
    const summary = this.document.createElement('p');
    summary.textContent = description;
    this.panel.replaceChildren(heading, summary);
    if (candidate) {
      const exampleList = this.document.createElement('ul');
      for (const { text } of candidate.messages.slice(-4)) {
        const example = this.document.createElement('li');
        example.textContent = text.slice(0, 220);
        exampleList.append(example);
      }
      this.panel.append(exampleList);
    }
    this.status.textContent = '';
    this.panel.append(this.status);
  }

  showAside(title: string, description: string) {
    this.show(title, description);
    this.panel.classList.add('bottom-left');
  }

  button(label: string, action: (button: HTMLButtonElement) => void) {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', event => { if (event.isTrusted) action(button); });
    this.panel.append(button);
    return button;
  }

  languageInput(initial: string | null) {
    const label = this.document.createElement('label');
    label.textContent = '回复语言 ';
    const input = this.document.createElement('input');
    input.value = initial ?? '';
    input.placeholder = '例如日语、Japanese、jp';
    input.maxLength = 80;
    label.append(input);
    this.panel.append(label);
    return input;
  }

  note(text: string) {
    this.status.textContent = text;
  }

  captureVisibility(visible: boolean) {
    this.panel.style.visibility = visible ? '' : 'hidden';
    this.outline.style.visibility = visible ? '' : 'hidden';
  }

  hide() {
    this.panel.hidden = true;
    this.highlight();
  }
}
