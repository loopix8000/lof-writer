import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { marked, type Token, type TokensList } from "marked";
import { X } from "lucide-react";
import { stripJsdocComments } from "../core/text.mjs";

export const devices = [
  { id: "galaxy", name: "Galaxy (360)", width: 360, height: 780 },
  { id: "iphone", name: "iPhone (390)", width: 390, height: 844 },
  { id: "large", name: "대화면 (412)", width: 412, height: 915 },
];
export const previewFontSizes = [14, 15, 16, 17, 18, 20];

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 웹소설 플랫폼처럼 빈 줄을 그대로 보여 준다. 줄 수 규칙은 core/text.mjs의 plainText와 같다.
function render(markdown: string) {
  const options = { gfm: true, breaks: true };
  const tokens = marked.lexer(stripJsdocComments(markdown), options);
  return tokens
    .map((t: Token) => {
      if (t.type === "space") {
        const blank = Math.max(
          0,
          Math.floor((t.raw.match(/\n/g) || []).length / 2) - 1,
        );
        return '<p class="blank">&nbsp;</p>'.repeat(blank);
      }
      const one = Object.assign([t], { links: tokens.links }) as TokensList;
      return marked.parser(one, options);
    })
    .join("");
}

function styles(dark: boolean, fontSize: number, manualLineBreak: boolean) {
  return `html{background:${dark ? "#1b1b1b" : "#ffffff"};color:${dark ? "#d8d8d8" : "#222222"};}
body{margin:0;padding:28px 20px 56px;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;
font-size:${fontSize}px;line-height:1.8;word-break:keep-all;overflow-wrap:anywhere;}
header{margin-bottom:28px;}
header small{display:block;font-size:12px;opacity:.6;margin-bottom:6px;}
header h1{font-size:1.35em;line-height:1.4;margin:0;}
p{margin:${manualLineBreak ? "0" : "0 0 1em"};}
p.blank{margin:0;}
hr{border:0;text-align:center;margin:2em 0;}
hr::after{content:"✧";opacity:.5;}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid ${dark ? "#444" : "#ddd"};opacity:.85;}
h1,h2,h3{font-size:1.15em;margin:1.5em 0 .7em;}
img{max-width:100%;}
::-webkit-scrollbar{width:0;}`;
}
// 처음 한 번만 불러오는 빈 화면. 이후에는 내용과 스타일만 바꿔 넣어 스크롤 위치를 지킨다.
const shell = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style></style></head><body></body></html>`;

// 휴대폰 화면 폭의 iframe에 원고를 그린다. sandbox에 allow-scripts가 없으므로 스크립트는 실행되지 않는다.
export default function MobilePreview({
  title,
  label,
  body,
  manualLineBreak = false,
  dark,
  device,
  fontSize,
  onDevice,
  onFontSize,
  onClose,
}: {
  title: string;
  label: string;
  body: string;
  manualLineBreak?: boolean;
  dark: boolean;
  device: string;
  fontSize: number;
  onDevice: (id: string) => void;
  onFontSize: (size: number) => void;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const size = devices.find((d) => d.id === device) || devices[1];
  const deferredBody = useDeferredValue(body);
  const html = useMemo(() => render(deferredBody), [deferredBody]);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const bezel = 24;
      setScale(
        Math.min(
          1,
          (el.clientWidth - 24) / (size.width + bezel),
          (el.clientHeight - 24) / (size.height + bezel),
        ),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size.width, size.height]);
  const paint = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d?.body) return;
    const style = d.querySelector("style");
    if (style) style.textContent = styles(dark, fontSize, manualLineBreak);
    d.body.innerHTML = `<header><small>${escape(label)}</small><h1>${escape(title || "제목 없음")}</h1></header>${html}`;
  }, [dark, fontSize, manualLineBreak, label, title, html]);
  useEffect(paint, [paint]);
  return (
    <aside className="mobile-preview" aria-label="모바일 미리보기">
      <div className="panel-caption">
        <span>모바일 미리보기</span>
        <button aria-label="모바일 미리보기 닫기" title="닫기" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="mobile-preview-options">
        <select
          aria-label="미리보기 기기"
          value={size.id}
          onChange={(e) => onDevice(e.target.value)}
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="미리보기 글자 크기"
          value={fontSize}
          onChange={(e) => onFontSize(Number(e.target.value))}
        >
          {previewFontSizes.map((s) => (
            <option key={s} value={s}>
              글자 {s}px
            </option>
          ))}
        </select>
      </div>
      <div className="mobile-preview-stage" ref={stage}>
        <div
          className="phone"
          style={{
            width: size.width + 24,
            height: size.height + 24,
            transform: `scale(${scale})`,
          }}
        >
          <iframe
            ref={frame}
            title="모바일 화면"
            sandbox="allow-same-origin"
            srcDoc={shell}
            onLoad={paint}
            style={{ width: size.width, height: size.height }}
          />
        </div>
      </div>
    </aside>
  );
}
