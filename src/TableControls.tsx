import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Editor, useEditorState } from "@tiptap/react";
import { type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Eraser,
  GripHorizontal,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";

type ActiveTableInfo = {
  tablePos: number;
  tableNode: PMNode;
  rowIndex: number;
  colIndex: number;
  rowCount: number;
  colCount: number;
};

function getActiveTableInfo(editor: Editor): ActiveTableInfo | null {
  if (!editor.isEditable || !editor.isActive("table")) return null;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 2; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      const rowNode = $from.node(d - 1);
      const tableNode = $from.node(d - 2);
      if (rowNode.type.name === "tableRow" && tableNode.type.name === "table") {
        return {
          tablePos: $from.before(d - 2),
          tableNode,
          rowIndex: $from.index(d - 2),
          colIndex: $from.index(d - 1),
          rowCount: tableNode.childCount,
          colCount: rowNode.childCount,
        };
      }
    }
  }
  return null;
}

function resolveCellPos(tableNode: PMNode, tablePos: number, targetRow: number, targetCol: number): number {
  let pos = tablePos + 1;
  const rClamp = Math.max(0, Math.min(targetRow, tableNode.childCount - 1));
  for (let r = 0; r < rClamp; r++) {
    pos += tableNode.child(r).nodeSize;
  }
  const rowNode = tableNode.child(rClamp);
  pos += 1;
  const cClamp = Math.max(0, Math.min(targetCol, rowNode.childCount - 1));
  for (let c = 0; c < cClamp; c++) {
    pos += rowNode.child(c).nodeSize;
  }
  return pos + 1;
}

function dispatchTableReplacement(
  editor: Editor,
  tablePos: number,
  oldTableNode: PMNode,
  newTableNode: PMNode,
  targetRow: number,
  targetCol: number,
) {
  const { state, view } = editor;
  const tr = state.tr.replaceWith(tablePos, tablePos + oldTableNode.nodeSize, newTableNode);
  const cellInsidePos = resolveCellPos(newTableNode, tablePos, targetRow, targetCol);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellInsidePos)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

type LayoutMetrics = {
  tableTop: number;
  tableLeft: number;
  tableWidth: number;
  tableHeight: number;
  cellTop: number;
  cellLeft: number;
  cellWidth: number;
  cellHeight: number;
};

export default function TableControls({
  editor,
  active,
}: {
  editor: Editor;
  active: boolean;
}) {
  const [openMenu, setOpenMenu] = useState<"row" | "col" | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 12, top: 12 });
  const [metrics, setMetrics] = useState<LayoutMetrics | null>(null);
  const rowBtnRef = useRef<HTMLButtonElement>(null);
  const colBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectionKey = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!active || !ed.isEditable || !ed.isActive("table")) return "";
      const info = getActiveTableInfo(ed);
      if (!info) return "";
      return `${info.tablePos}:${info.rowIndex}:${info.colIndex}:${info.rowCount}:${info.colCount}:${ed.state.doc.content.size}`;
    },
  });

  const info = selectionKey ? getActiveTableInfo(editor) : null;

  const updateMetrics = useCallback(() => {
    if (!active || !editor.isEditable || !editor.isActive("table")) {
      setMetrics(null);
      return;
    }
    const { $from } = editor.state.selection;
    const domAt = editor.view.domAtPos($from.pos);
    const baseEl = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
    const cellEl = baseEl?.closest<HTMLTableCellElement>("td, th");
    const tableEl = cellEl?.closest<HTMLTableElement>("table");
    const containerEl = editor.view.dom.parentElement;
    if (!cellEl || !tableEl || !containerEl) {
      setMetrics(null);
      return;
    }
    const containerRect = containerEl.getBoundingClientRect();
    const tableRect = tableEl.getBoundingClientRect();
    const cellRect = cellEl.getBoundingClientRect();
    setMetrics({
      tableTop: tableRect.top - containerRect.top,
      tableLeft: tableRect.left - containerRect.left,
      tableWidth: tableRect.width,
      tableHeight: tableRect.height,
      cellTop: cellRect.top - containerRect.top,
      cellLeft: cellRect.left - containerRect.left,
      cellWidth: cellRect.width,
      cellHeight: cellRect.height,
    });
  }, [active, editor]);

  // 셀 위치가 바뀌면 열려 있던 행/열 메뉴를 닫고 좌표를 갱신한다.
  useLayoutEffect(() => {
    setOpenMenu(null);
    updateMetrics();
  }, [selectionKey, updateMetrics]);

  // 창 크기 변경이나 표 내부 스크롤·변화 시 위치를 동기화한다.
  useEffect(() => {
    if (!selectionKey) return;
    const onUpdate = () => updateMetrics();
    window.addEventListener("resize", onUpdate);
    window.addEventListener("scroll", onUpdate, true);
    editor.on("transaction", onUpdate);
    return () => {
      window.removeEventListener("resize", onUpdate);
      window.removeEventListener("scroll", onUpdate, true);
      editor.off("transaction", onUpdate);
    };
  }, [editor, selectionKey, updateMetrics]);

  // 행 또는 열 메뉴가 열려 있을 때 해당 행/열의 셀들을 하이라이트한다.
  useEffect(() => {
    if (!openMenu || !info) return;
    const { $from } = editor.state.selection;
    const domAt = editor.view.domAtPos($from.pos);
    const baseEl = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
    const tableEl = baseEl?.closest<HTMLTableElement>("table");
    if (!tableEl) return;

    const highlighted: HTMLElement[] = [];
    if (openMenu === "row") {
      const row = tableEl.rows[info.rowIndex];
      if (row) {
        for (const cell of Array.from(row.cells)) {
          cell.setAttribute("data-table-highlight", "row");
          highlighted.push(cell);
        }
      }
    } else if (openMenu === "col") {
      for (const row of Array.from(tableEl.rows)) {
        const cell = row.cells[info.colIndex];
        if (cell) {
          cell.setAttribute("data-table-highlight", "col");
          highlighted.push(cell);
        }
      }
    }
    return () => {
      for (const cell of highlighted) {
        cell.removeAttribute("data-table-highlight");
      }
    };
  }, [editor, openMenu, info?.tablePos, info?.rowIndex, info?.colIndex]);

  // 팝오버 메뉴 좌표 계산 및 바깥 클릭/Escape 닫기
  useLayoutEffect(() => {
    if (!openMenu) return;
    const updateMenuPos = () => {
      const anchor = openMenu === "row" ? rowBtnRef.current : colBtnRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const aRect = anchor.getBoundingClientRect();
      const mRect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = openMenu === "row" ? aRect.right + 6 : aRect.left + aRect.width / 2 - mRect.width / 2;
      let top = openMenu === "row" ? aRect.top : aRect.bottom + 6;

      if (openMenu === "row" && left + mRect.width > vw - 8) {
        left = aRect.left - mRect.width - 6;
      }
      if (top + mRect.height > vh - 8 && aRect.top - mRect.height - 6 >= 8) {
        top = openMenu === "row" ? vh - mRect.height - 8 : aRect.top - mRect.height - 6;
      }
      left = Math.max(8, Math.min(left, vw - mRect.width - 8));
      top = Math.max(8, Math.min(top, vh - mRect.height - 8));
      setMenuPos({ left, top });
    };
    updateMenuPos();
    window.addEventListener("resize", updateMenuPos);
    window.addEventListener("scroll", updateMenuPos, true);
    return () => {
      window.removeEventListener("resize", updateMenuPos);
      window.removeEventListener("scroll", updateMenuPos, true);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        menuRef.current?.contains(target) ||
        rowBtnRef.current?.contains(target) ||
        colBtnRef.current?.contains(target)
      ) {
        return;
      }
      setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpenMenu(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openMenu]);

  const containerEl = editor.view.dom.parentElement;
  if (!active || !info || !metrics || !containerEl) return null;

  const { tablePos, tableNode, rowIndex, colIndex, rowCount, colCount } = info;
  const { schema } = editor.state;

  const createEmptyCell = (isHeader: boolean) => {
    const type = isHeader ? schema.nodes.tableHeader : schema.nodes.tableCell;
    return type.createAndFill()!;
  };

  const cloneCellWithType = (cell: PMNode, isHeader: boolean) => {
    const type = isHeader ? schema.nodes.tableHeader : schema.nodes.tableCell;
    return type.create(cell.attrs, cell.content);
  };

  // 표 맨 아래에 새 행 추가
  const appendRowAtBottom = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((r) => rows.push(r));
    const cells: PMNode[] = [];
    for (let c = 0; c < colCount; c++) {
      cells.push(createEmptyCell(false));
    }
    rows.push(schema.nodes.tableRow.create(null, cells));
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rows.length - 1, 0);
  };

  // 표 맨 오른쪽에 새 열 추가
  const appendColAtRight = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((row, _offset, rIdx) => {
      const cells: PMNode[] = [];
      row.forEach((cell) => cells.push(cell));
      cells.push(createEmptyCell(rIdx === 0));
      rows.push(row.type.create(row.attrs, cells));
    });
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex, colCount);
  };

  // 행 이동 (위/아래)
  const moveRow = (delta: -1 | 1) => {
    const target = rowIndex + delta;
    if (target < 0 || target >= rowCount) return;
    const rows: PMNode[] = [];
    tableNode.forEach((r) => rows.push(r));
    const [moved] = rows.splice(rowIndex, 1);
    rows.splice(target, 0, moved);
    const normalizedRows = rows.map((row, rIdx) => {
      const cells: PMNode[] = [];
      row.forEach((cell) => cells.push(cloneCellWithType(cell, rIdx === 0)));
      return row.type.create(row.attrs, cells);
    });
    const nextTable = tableNode.type.create(tableNode.attrs, normalizedRows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, target, colIndex);
    setOpenMenu(null);
  };

  // 행 복제
  const duplicateRow = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((r) => rows.push(r));
    const sourceRow = rows[rowIndex];
    const clonedCells: PMNode[] = [];
    sourceRow.forEach((cell) => clonedCells.push(cloneCellWithType(cell, false)));
    const clonedRow = sourceRow.type.create(sourceRow.attrs, clonedCells);
    rows.splice(rowIndex + 1, 0, clonedRow);
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex + 1, colIndex);
    setOpenMenu(null);
  };

  // 행 내용 비우기
  const clearRow = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((row, _offset, rIdx) => {
      if (rIdx !== rowIndex) {
        rows.push(row);
        return;
      }
      const cells: PMNode[] = [];
      for (let c = 0; c < row.childCount; c++) {
        cells.push(createEmptyCell(rIdx === 0));
      }
      rows.push(row.type.create(row.attrs, cells));
    });
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex, colIndex);
    setOpenMenu(null);
  };

  // 열 이동 (왼쪽/오른쪽)
  const moveCol = (delta: -1 | 1) => {
    const target = colIndex + delta;
    if (target < 0 || target >= colCount) return;
    const rows: PMNode[] = [];
    tableNode.forEach((row) => {
      const cells: PMNode[] = [];
      row.forEach((cell) => cells.push(cell));
      const [moved] = cells.splice(colIndex, 1);
      cells.splice(target, 0, moved);
      rows.push(row.type.create(row.attrs, cells));
    });
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex, target);
    setOpenMenu(null);
  };

  // 열 복제
  const duplicateCol = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((row, _offset, rIdx) => {
      const cells: PMNode[] = [];
      row.forEach((cell) => cells.push(cell));
      const sourceCell = cells[colIndex];
      cells.splice(colIndex + 1, 0, cloneCellWithType(sourceCell, rIdx === 0));
      rows.push(row.type.create(row.attrs, cells));
    });
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex, colIndex + 1);
    setOpenMenu(null);
  };

  // 열 내용 비우기
  const clearCol = () => {
    const rows: PMNode[] = [];
    tableNode.forEach((row, _offset, rIdx) => {
      const cells: PMNode[] = [];
      row.forEach((cell, _cOffset, cIdx) => {
        cells.push(cIdx === colIndex ? createEmptyCell(rIdx === 0) : cell);
      });
      rows.push(row.type.create(row.attrs, cells));
    });
    const nextTable = tableNode.type.create(tableNode.attrs, rows);
    dispatchTableReplacement(editor, tablePos, tableNode, nextTable, rowIndex, colIndex);
    setOpenMenu(null);
  };

  const colCenterLeft = Math.max(
    metrics.tableLeft + 14,
    Math.min(metrics.cellLeft + metrics.cellWidth / 2, metrics.tableLeft + metrics.tableWidth - 14),
  );
  const rowCenterTop = Math.max(
    metrics.tableTop + 14,
    Math.min(metrics.cellTop + metrics.cellHeight / 2, metrics.tableTop + metrics.tableHeight - 14),
  );

  return createPortal(
    <div className="notion-table-controls" aria-label="표 편집 컨트롤">
      {/* 상단 열 핸들 (⋯) */}
      <button
        ref={colBtnRef}
        type="button"
        className={`notion-table-handle col${openMenu === "col" ? " active" : ""}`}
        style={{
          top: metrics.tableTop,
          left: colCenterLeft,
        }}
        aria-label={`${colIndex + 1}열 옵션 메뉴`}
        aria-expanded={openMenu === "col"}
        title="열 옵션 (클릭하여 열 추가·이동·삭제)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpenMenu((prev) => (prev === "col" ? null : "col"))}
      >
        <GripHorizontal size={13} />
      </button>

      {/* 좌측 행 핸들 (⋮⋮) */}
      <button
        ref={rowBtnRef}
        type="button"
        className={`notion-table-handle row${openMenu === "row" ? " active" : ""}`}
        style={{
          top: rowCenterTop,
          left: metrics.tableLeft,
        }}
        aria-label={`${rowIndex + 1}행 옵션 메뉴`}
        aria-expanded={openMenu === "row"}
        title="행 옵션 (클릭하여 행 추가·이동·삭제)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpenMenu((prev) => (prev === "row" ? null : "row"))}
      >
        <GripVertical size={13} />
      </button>

      {/* 하단 새 행 추가 바 (+) */}
      <button
        type="button"
        className="notion-table-add-bar row"
        style={{
          top: metrics.tableTop + metrics.tableHeight + 2,
          left: metrics.tableLeft,
          width: metrics.tableWidth,
        }}
        aria-label="아래에 새 행 추가"
        title="아래에 새 행 추가"
        onMouseDown={(e) => e.preventDefault()}
        onClick={appendRowAtBottom}
      >
        <Plus size={13} />
      </button>

      {/* 우측 새 열 추가 바 (+) */}
      <button
        type="button"
        className="notion-table-add-bar col"
        style={{
          top: metrics.tableTop,
          left: metrics.tableLeft + metrics.tableWidth + 2,
          height: metrics.tableHeight,
        }}
        aria-label="오른쪽에 새 열 추가"
        title="오른쪽에 새 열 추가"
        onMouseDown={(e) => e.preventDefault()}
        onClick={appendColAtRight}
      >
        <Plus size={13} />
      </button>

      {/* 행 / 열 팝오버 메뉴 */}
      {openMenu &&
        createPortal(
          <div
            ref={menuRef}
            className="notion-table-menu"
            role="menu"
            aria-label={openMenu === "row" ? "행 편집 메뉴" : "열 편집 메뉴"}
            style={menuPos}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="notion-table-menu-header">
              {openMenu === "row"
                ? `${rowIndex + 1}행 ${rowIndex === 0 ? "(머리글)" : ""}`
                : `${colIndex + 1}열`}
            </div>
            {openMenu === "row" ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={() => {
                    editor.chain().focus().addRowBefore().run();
                    setOpenMenu(null);
                  }}
                >
                  <ArrowUpToLine size={15} />
                  <span>위에 행 삽입</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={() => {
                    editor.chain().focus().addRowAfter().run();
                    setOpenMenu(null);
                  }}
                >
                  <ArrowDownToLine size={15} />
                  <span>아래에 행 삽입</span>
                </button>
                <div className="notion-table-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  disabled={rowIndex <= 0}
                  onClick={() => moveRow(-1)}
                >
                  <ArrowUp size={15} />
                  <span>위로 이동</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  disabled={rowIndex >= rowCount - 1}
                  onClick={() => moveRow(1)}
                >
                  <ArrowDown size={15} />
                  <span>아래로 이동</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={duplicateRow}
                >
                  <Copy size={15} />
                  <span>행 복제</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={clearRow}
                >
                  <Eraser size={15} />
                  <span>내용 비우기</span>
                </button>
                <div className="notion-table-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item danger"
                  onClick={() => {
                    if (rowCount <= 1) {
                      editor.chain().focus().deleteTable().run();
                    } else {
                      editor.chain().focus().deleteRow().run();
                    }
                    setOpenMenu(null);
                  }}
                >
                  <Trash2 size={15} />
                  <span>행 삭제</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item danger"
                  onClick={() => {
                    editor.chain().focus().deleteTable().run();
                    setOpenMenu(null);
                  }}
                >
                  <Trash2 size={15} />
                  <span>표 전체 삭제</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={() => {
                    editor.chain().focus().addColumnBefore().run();
                    setOpenMenu(null);
                  }}
                >
                  <ArrowLeftToLine size={15} />
                  <span>왼쪽에 열 삽입</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={() => {
                    editor.chain().focus().addColumnAfter().run();
                    setOpenMenu(null);
                  }}
                >
                  <ArrowRightToLine size={15} />
                  <span>오른쪽에 열 삽입</span>
                </button>
                <div className="notion-table-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  disabled={colIndex <= 0}
                  onClick={() => moveCol(-1)}
                >
                  <ArrowLeft size={15} />
                  <span>왼쪽으로 이동</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  disabled={colIndex >= colCount - 1}
                  onClick={() => moveCol(1)}
                >
                  <ArrowRight size={15} />
                  <span>오른쪽으로 이동</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={duplicateCol}
                >
                  <Copy size={15} />
                  <span>열 복제</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item"
                  onClick={clearCol}
                >
                  <Eraser size={15} />
                  <span>내용 비우기</span>
                </button>
                <div className="notion-table-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item danger"
                  onClick={() => {
                    if (colCount <= 1) {
                      editor.chain().focus().deleteTable().run();
                    } else {
                      editor.chain().focus().deleteColumn().run();
                    }
                    setOpenMenu(null);
                  }}
                >
                  <Trash2 size={15} />
                  <span>열 삭제</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="notion-table-menu-item danger"
                  onClick={() => {
                    editor.chain().focus().deleteTable().run();
                    setOpenMenu(null);
                  }}
                >
                  <Trash2 size={15} />
                  <span>표 전체 삭제</span>
                </button>
              </>
            )}
          </div>,
          document.querySelector(".app") ?? document.body,
        )}
    </div>,
    containerEl,
  );
}
