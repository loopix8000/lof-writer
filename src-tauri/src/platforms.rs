use crate::error::slice_utf16;
use serde_json::{json, Map, Value};

#[derive(Clone, Copy)]
struct PlatformPreset {
    id: &'static str,
    name: &'static str,
    rule: &'static str,
    goal: i64,
}

const PLATFORMS: &[PlatformPreset] = &[
    PlatformPreset {
        id: "novelpia",
        name: "노벨피아",
        rule: "novelpia",
        goal: 3000,
    },
    PlatformPreset {
        id: "munpia",
        name: "문피아",
        rule: "all",
        goal: 5000,
    },
    PlatformPreset {
        id: "naver",
        name: "네이버 시리즈",
        rule: "all",
        goal: 5000,
    },
    PlatformPreset {
        id: "kakao",
        name: "카카오페이지",
        rule: "all",
        goal: 5000,
    },
    PlatformPreset {
        id: "spaces",
        name: "공백·줄바꿈 포함",
        rule: "all",
        goal: 5000,
    },
    PlatformPreset {
        id: "manuscript",
        name: "원고지 규격",
        rule: "manuscript",
        goal: 25,
    },
    PlatformPreset {
        id: "custom",
        name: "사용자 규칙",
        rule: "noSpace",
        goal: 3000,
    },
];

pub fn normalize_writing(input: Option<&Value>) -> Value {
    let obj = input.and_then(|v| v.as_object());
    let platform_in = obj.and_then(|o| o.get("platform")).and_then(|v| v.as_str());
    let mut preset = PLATFORMS
        .iter()
        .find(|p| Some(p.id) == platform_in)
        .copied()
        .unwrap_or(PLATFORMS[0]);

    let version_in = obj.and_then(|o| o.get("version")).and_then(|v| v.as_i64());
    let legacy = version_in != Some(2)
        && platform_in.is_some_and(|p| !p.is_empty() && p != "custom");
    let old_rule = if platform_in == Some("novelpia") {
        "noSpace"
    } else if platform_in == Some("manuscript") {
        "manuscript"
    } else {
        "spaces"
    };
    let raw_rule = obj.and_then(|o| o.get("rule")).and_then(|v| v.as_str());
    let is_override = legacy && raw_rule.is_some_and(|r| !r.is_empty() && r != old_rule);
    // 없앤 "공백 포함 · 줄바꿈 제외" 규칙은 "공백·줄바꿈 포함"으로 바꾼다.
    let rule_in = raw_rule.map(|r| if r == "spaces" { "all" } else { r });

    let custom_name_in = obj
        .and_then(|o| o.get("customName"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let custom_name = if is_override {
        if !custom_name_in.is_empty() {
            custom_name_in.to_string()
        } else {
            format!("{} 개인 규칙", preset.name)
        }
    } else {
        custom_name_in.to_string()
    };

    if is_override {
        preset = *PLATFORMS.iter().find(|p| p.id == "custom").unwrap();
    }
    let custom = preset.id == "custom";

    let goal_in = obj.and_then(|o| o.get("goal")).and_then(|v| {
        if let Some(i) = v.as_i64() {
            Some(i)
        } else if let Some(f) = v.as_f64() {
            if f.fract() == 0.0 {
                Some(f as i64)
            } else {
                None
            }
        } else if let Some(s) = v.as_str() {
            s.parse::<i64>().ok()
        } else {
            None
        }
    });
    let goal = match goal_in {
        Some(g) if (1..=1_000_000).contains(&g) => g,
        _ => preset.goal,
    };

    let rule = if custom
        && rule_in.is_some_and(|r| {
            ["noSpace", "all", "collapsed", "novelpia", "manuscript"].contains(&r)
        }) {
        rule_in.unwrap()
    } else {
        preset.rule
    };

    let punct_in = obj
        .and_then(|o| o.get("punctuation"))
        .and_then(|v| v.as_str());
    let punctuation = if custom
        && punct_in.is_some_and(|p| ["include", "ascii", "unicode"].contains(&p))
    {
        punct_in.unwrap()
    } else {
        "include"
    };

    let exclude_special = custom
        && obj
            .and_then(|o| o.get("excludeSpecial"))
            .and_then(|v| v.as_bool())
            == Some(true);

    let ellipsis_weight = if custom
        && obj
            .and_then(|o| o.get("ellipsisWeight"))
            .and_then(|v| v.as_i64())
            == Some(3)
    {
        3
    } else {
        1
    };

    let mut out = Map::new();
    out.insert("version".to_string(), json!(2));
    out.insert("platform".to_string(), json!(preset.id));
    out.insert("rule".to_string(), json!(rule));
    out.insert("unit".to_string(), json!("utf16"));
    out.insert("punctuation".to_string(), json!(punctuation));
    out.insert("excludeSpecial".to_string(), json!(exclude_special));
    out.insert("ellipsisWeight".to_string(), json!(ellipsis_weight));
    out.insert("goal".to_string(), json!(goal));
    out.insert("customName".to_string(), json!(slice_utf16(&custom_name, 60)));
    Value::Object(out)
}
