"""원본 글꼴 테이블을 보존한 WOFF2 파일을 생성한다. fonttools[woff]가 필요하다."""

from pathlib import Path

from fontTools.ttLib import TTFont, woff2


root = Path(__file__).resolve().parent.parent / "src" / "fonts"
for name in ("RIDIBatang.otf", "NotoSansKR-Variable.ttf"):
    source = root / name
    target = source.with_suffix(".woff2")
    # 글리프·메타데이터를 재작성하지 않고 압축만 적용한다.
    woff2.compress(source, target, transform_tables=set())
    with TTFont(source, lazy=True) as original, TTFont(target, lazy=True) as compressed:
        original_tables = set(original.reader.keys())
        # WOFF2에서는 실제 서명이 없는 빈 서명 테이블을 저장하지 않는다.
        if "DSIG" in original_tables and original.reader["DSIG"] == b"\x00\x00\x00\x01\x00\x00\x00\x00":
            original_tables.remove("DSIG")
        if original_tables != set(compressed.reader.keys()):
            raise RuntimeError(f"글꼴 테이블 목록이 변경되었습니다: {name}")
        for tag in original_tables:
            before, after = original.reader[tag], compressed.reader[tag]
            # 전체 파일 체크섬과 WOFF2 무손실 압축 표시 비트만 컨테이너에 따라 달라진다.
            if tag == "head":
                def clear_compression_flag(data):
                    flags = int.from_bytes(data[16:18], "big") & ~(1 << 11)
                    return data[:16] + flags.to_bytes(2, "big") + data[18:]
                before, after = clear_compression_flag(before), clear_compression_flag(after)
                before, after = before[:8] + before[12:], after[:8] + after[12:]
            if before != after:
                raise RuntimeError(f"글꼴 테이블 내용이 변경되었습니다: {name} / {tag}")
    print(f"{name}: {source.stat().st_size:,} → {target.stat().st_size:,}바이트")
