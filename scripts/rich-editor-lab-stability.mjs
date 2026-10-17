// 성능 측정을 끝낸 같은 사본에서만 실행한다. 제품·원본 문서는 수정하지 않는다.
export async function checkRichEditorStability(page, cdp) {
  const checks = [];
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => JSON.stringify(window.__labEditor.state.doc.toJSON()));
  const initial = await snapshot();
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const test = async (name, fn) => {
    try { checks.push({ name, ok: true, detail: await fn() }); }
    catch (error) { checks.push({ name, ok: false, error: error.message }); }
  };

  for (const location of ["start", "middle", "end"]) {
    await test(`커서·스크롤·좌표: ${location}`, async () => {
      await page.evaluate(location => {
        const editor = window.__labEditor, positions = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.isTextblock && node.content.size) { positions.push(pos + 1); return false; }
        });
        const index = location === "start" ? 0 : location === "middle" ? Math.floor(positions.length / 2) : positions.length - 1;
        editor.chain().focus().setTextSelection(positions[index]).scrollIntoView().run();
      }, location);
      await settle();
      const before = await page.evaluate(() => {
        const view = window.__labEditor.view, at = view.state.selection.from;
        const dom = view.domAtPos(at), coords = view.coordsAtPos(at);
        const scroller = document.querySelector(".editor-scroll"), bounds = scroller.getBoundingClientRect();
        const selection = window.getSelection();
        return { at, roundtrip: view.posAtDOM(dom.node, dom.offset), top: coords.top, bottom: coords.bottom,
          viewportTop: bounds.top, viewportBottom: bounds.bottom, scroll: scroller.scrollTop,
          nativeAt: selection?.anchorNode && view.dom.contains(selection.anchorNode) ? view.posAtDOM(selection.anchorNode, selection.anchorOffset) : null };
      });
      await page.evaluate(() => new Promise(resolve => {
        let frames = 8;
        const next = () => --frames ? requestAnimationFrame(next) : resolve();
        requestAnimationFrame(next);
      }));
      const after = await page.evaluate(() => document.querySelector(".editor-scroll").scrollTop);
      assert(before.at === before.roundtrip && before.at === before.nativeAt, "문서·DOM 커서 위치가 다릅니다.");
      assert(before.bottom >= before.viewportTop && before.top <= before.viewportBottom, "커서가 화면 밖에 있습니다.");
      assert(Math.abs(after - before.scroll) <= 2, `스크롤이 안정된 뒤 ${Math.abs(after - before.scroll)}px 움직였습니다.`);
      return { position: before.at, scrollDrift: after - before.scroll };
    });
  }

  await test("화면 밖을 포함한 전체 선택·복사", async () => {
    const result = await page.evaluate(async () => {
      const editor = window.__labEditor, app = document.querySelector(".lab-app");
      const selected = () => {
        editor.commands.selectAll();
        editor.view.focus();
        return {
          clipboard: editor.view.serializeForClipboard(editor.state.selection.content()).text,
          native: window.getSelection()?.toString(), size: editor.state.selection.to - editor.state.selection.from,
        };
      };
      const optimized = selected(), enabled = app.classList.contains("lab-windowed");
      // 브라우저의 선택 문자열은 문단 구분 규칙이 있어 비최적화 상태와 직접 대조한다.
      app.classList.remove("lab-windowed");
      void editor.view.dom.offsetHeight;
      const baseline = selected();
      if (enabled) app.classList.add("lab-windowed");
      return { clipboardEqual: optimized.clipboard === baseline.clipboard, nativeEqual: optimized.native === baseline.native,
        selectedSize: optimized.size, documentSize: editor.state.doc.content.size, copiedCharacters: optimized.clipboard.length };
    });
    assert(result.clipboardEqual && result.nativeEqual && result.copiedCharacters > 0, "전체 복사 또는 브라우저 선택 문자열이 달라졌습니다.");
    assert(result.selectedSize === result.documentSize, "전체 문서가 선택되지 않았습니다.");
    return result;
  });

  const actualWriter = await page.evaluate(() => ["writer", "writer-no-cursor", "writer-visibility"].includes(new URLSearchParams(location.search).get("mode")));
  if (actualWriter) await test("화면 밖 검색 결과로 이동", async () => {
    const match = await page.evaluate(() => {
      const editor = window.__labEditor, paragraphs = [];
      editor.state.doc.descendants(node => { if (node.isTextblock && node.textContent.length >= 12) paragraphs.push(node.textContent); });
      const query = paragraphs[Math.floor(paragraphs.length / 2)].slice(1, 11);
      const matches = [];
      editor.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        const text = node.textContent;
        for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) matches.push(pos + 1 + at);
      });
      window.__lab.controls.reveal(query, matches.length - 1);
      return { query, position: matches.at(-1) };
    });
    await settle();
    const selection = await page.evaluate(() => {
      const view = window.__labEditor.view, { from, to } = view.state.selection;
      const coords = view.coordsAtPos(from), bounds = document.querySelector(".editor-scroll").getBoundingClientRect();
      return { from, text: view.state.doc.textBetween(from, to), visible: coords.bottom >= bounds.top && coords.top <= bounds.bottom };
    });
    assert(selection.text === match.query && selection.from === match.position && selection.visible, "검색 결과 선택·스크롤 위치가 다릅니다.");
    return { position: selection.from };
  });

  await test("입력·되돌리기·다시 실행", async () => {
    await page.evaluate(() => {
      const editor = window.__labEditor;
      editor.chain().focus().setTextSelection(editor.state.doc.content.size - 1).run();
      window.__lab.historyBoundary();
    });
    await settle();
    const before = await snapshot();
    await cdp.send("Input.insertText", { text: "입력검증" });
    await settle();
    const edited = await snapshot();
    assert(edited !== before, "입력이 반영되지 않았습니다.");
    await page.evaluate(() => window.__labEditor.commands.undo()); await settle();
    assert(await snapshot() === before, "되돌리기가 원문을 복원하지 못했습니다.");
    await page.evaluate(() => window.__labEditor.commands.redo()); await settle();
    assert(await snapshot() === edited, "다시 실행 결과가 다릅니다.");
    await page.evaluate(() => window.__labEditor.commands.undo()); await settle();
  });

  await test("여러 줄 붙여넣기·되돌리기", async () => {
    const before = await snapshot();
    await page.evaluate(() => {
      window.__lab.historyBoundary();
      window.__labEditor.view.pasteText("붙여넣기 첫 줄\n붙여넣기 둘째 줄");
    });
    await settle();
    const text = await page.evaluate(() => window.__labEditor.state.doc.textContent);
    assert(text.includes("붙여넣기 첫 줄") && text.includes("붙여넣기 둘째 줄"), "붙여넣은 줄이 누락됐습니다.");
    await page.evaluate(() => window.__labEditor.commands.undo()); await settle();
    assert(await snapshot() === before, "붙여넣기 되돌리기 결과가 다릅니다.");
  });

  await test("한글 조합 이벤트·확정", async () => {
    await page.evaluate(() => {
      const editor = window.__labEditor;
      editor.chain().focus().setTextSelection(editor.state.doc.content.size - 1).run();
      window.__lab.historyBoundary();
    });
    await settle();
    const before = await page.evaluate(() => window.__labEditor.state.doc.textContent);
    for (const text of ["ㅎ", "하", "한"]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    }
    await cdp.send("Input.insertText", { text: "한" });
    await settle();
    const after = await page.evaluate(() => ({ text: window.__labEditor.state.doc.textContent, composing: window.__labEditor.view.composing }));
    assert(after.text === before + "한" && !after.composing, "한글 조합 중복·누락 또는 조합 종료 오류가 있습니다.");
    await page.evaluate(() => window.__labEditor.commands.undo()); await settle();
    return { simulatedComposition: true, osImeVerified: false };
  });

  if (actualWriter) {
    await test("북마크·메모 여백 아이콘 클릭", async () => {
      const target = await page.evaluate(() => {
        const editor = window.__labEditor;
        let selected;
        editor.state.doc.forEach((node, offset, index) => {
          if (!selected && node.type.name === "paragraph" && node.textContent.trim().length >= 12)
            selected = { index, at: offset + 1, text: node.textContent.replace(/\s+/g, " ").trim() };
        });
        window.__lab.controls.gutters(true, selected.index, selected.text);
        return selected;
      });
      try {
        await page.waitForSelector(".bookmarked.noted");
        await page.evaluate(at => window.__labEditor.chain().focus().setTextSelection(at).scrollIntoView().run(), target.at);
        await settle();
        const hit = await page.evaluate(() => {
          const app = document.querySelector(".lab-app"), enabled = app.classList.contains("lab-windowed");
          const element = document.querySelector(".bookmarked.noted");
          const sample = () => {
            const rect = element.getBoundingClientRect();
            return { bookmark: document.elementFromPoint(rect.left - 25, rect.top + 12) === element,
              note: document.elementFromPoint(rect.left - 52, rect.top + 12) === element,
              x: rect.left - 52, y: rect.top + 12 };
          };
          const optimized = sample();
          app.classList.remove("lab-windowed"); void element.offsetHeight;
          const baseline = sample();
          if (enabled) app.classList.add("lab-windowed");
          return { optimized, baseline, opened: window.__lab.noteOpens || 0 };
        });
        assert(hit.baseline.bookmark && hit.baseline.note, "대조군의 여백 아이콘 클릭 위치가 올바르지 않습니다.");
        assert(hit.optimized.bookmark && hit.optimized.note, "배치 생략으로 북마크·메모 여백 아이콘 클릭이 차단됐습니다.");
        await page.mouse.click(hit.optimized.x, hit.optimized.y);
        assert(await page.evaluate(() => window.__lab.noteOpens || 0) === hit.opened + 1, "메모 아이콘 클릭이 전달되지 않았습니다.");
        await page.mouse.click(hit.optimized.x + 27, hit.optimized.y);
        await settle();
        assert(await page.evaluate(() => !document.querySelector(".noted.bookmarked")), "북마크 아이콘 클릭이 전달되지 않았습니다.");
        return { bookmarkToggle: true, noteClick: true };
      } finally {
        await page.evaluate(() => window.__lab.controls.gutters(false)); await settle();
      }
    });
    await test("원문 편집 전환·복귀 시 본문 보존", async () => {
      const markdown = await page.evaluate(() => window.__labEditor.getMarkdown());
      await page.evaluate(() => window.__lab.controls.setSource(true));
      await page.waitForFunction(() => window.__lab.sourceMode && window.__labSource && !window.__labSource.destroyed && document.querySelector(".cm-content"));
      await settle();
      assert(await page.evaluate(() => window.__labSource.state.doc.toString()) === markdown, "원문 전환 시 본문이 달라졌습니다.");
      await page.evaluate(() => window.__lab.controls.setSource(false));
      await page.waitForFunction(() => !window.__lab.sourceMode && document.querySelector(".tiptap"));
      await settle();
      assert(await page.evaluate(() => window.__labEditor.getMarkdown()) === markdown, "일반 편집 복귀 시 본문이 달라졌습니다.");
    });
    await test("문서 전환·재개방 시 본문 보존", async () => {
      const before = await snapshot();
      const markdown = await page.evaluate(() => window.__labEditor.getMarkdown());
      await page.evaluate(() => window.__lab.controls.open("lab-other", "문서 전환 검증\n\n두 번째 문단"));
      await page.waitForFunction(() => window.__lab.documentId === "lab-other" && window.__labEditor && !window.__labEditor.isDestroyed && window.__labEditor.state.doc.textContent.includes("문서 전환 검증"));
      await page.evaluate(markdown => window.__lab.controls.open("lab", markdown), markdown);
      await page.waitForFunction(() => window.__lab.documentId === "lab" && window.__labEditor && !window.__labEditor.isDestroyed && !window.__labEditor.state.doc.textContent.includes("문서 전환 검증"));
      await settle();
      assert(await snapshot() === before, "문서를 다시 열었을 때 본문 구조가 달라졌습니다.");
    });
  }
  checks.push({ name: "검증 후 전체 문서 보존", ok: await snapshot() === initial });
  return { ok: checks.every(check => check.ok), checks };
}
