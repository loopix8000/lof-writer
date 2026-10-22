//! 작품 순서는 DB에 보관하고 기존 파일 동기화로 전달할 사본만 서재에 둔다.
use crate::{
    database::LibraryDb,
    error::{fail_invalid, valid_id, LofError},
    store::atomic_write_bytes,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashSet, fs, io::Read, path::Path};
use uuid::Uuid;

// 숨김 관리 폴더를 공유하지 않는 이전 앱도 일반 파일로 전달할 수 있는 경로다.
pub(crate) const FILE: &str = "lof-writer-library-order-v1.json";
const KEY: &str = "projectOrderState";
const MAX_BYTES: usize = 1_000_000;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectOrder {
    format: String,
    version: u32,
    updated_at: i64,
    revision: String,
    pub ids: Vec<String>,
}

fn valid_ids(ids: &[String]) -> bool {
    let mut unique = HashSet::new();
    ids.len() <= 10_000 && ids.iter().all(|id| valid_id(id) && unique.insert(id))
}

fn parse(bytes: &[u8]) -> Option<ProjectOrder> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let order: ProjectOrder = serde_json::from_slice(bytes).ok()?;
    (order.format == "lof-writer-library-order"
        && order.version == 1
        && (0..253_402_300_800_000).contains(&order.updated_at)
        && Uuid::parse_str(&order.revision).is_ok()
        && valid_ids(&order.ids))
    .then_some(order)
}

fn stored(db: &LibraryDb) -> Result<Option<ProjectOrder>, LofError> {
    Ok(db
        .get(KEY)?
        .and_then(|value| parse(value.to_string().as_bytes())))
}

fn bytes(order: &ProjectOrder) -> Result<Vec<u8>, LofError> {
    serde_json::to_vec(order).map_err(|error| fail_invalid(error.to_string()))
}

fn newest(left: ProjectOrder, right: ProjectOrder) -> ProjectOrder {
    // 같은 시각에 순서를 바꿔도 모든 기기에서 같은 결과를 선택한다.
    if (right.updated_at, &right.revision, &right.ids)
        > (left.updated_at, &left.revision, &left.ids)
    {
        right
    } else {
        left
    }
}

fn updated(ids: Vec<String>, previous: Option<&ProjectOrder>, initial: bool) -> ProjectOrder {
    ProjectOrder {
        format: "lof-writer-library-order".into(),
        version: 1,
        // 기존 DB를 처음 이관할 때는 다른 기기에서 명시적으로 바꾼 순서를 우선한다.
        updated_at: if initial {
            0
        } else {
            chrono::Utc::now()
                .timestamp_millis()
                .max(previous.map_or(0, |order| order.updated_at + 1))
        },
        revision: Uuid::new_v4().to_string(),
        ids,
    }
}

fn save_db(db: &LibraryDb, order: &ProjectOrder) -> Result<(), LofError> {
    db.set_project_order(
        &json!(order.ids),
        &serde_json::to_value(order).map_err(|error| fail_invalid(error.to_string()))?,
    )
}

fn file_bytes(root: &Path) -> Result<Option<Vec<u8>>, LofError> {
    let path = crate::sync::file_remote::safe_path(root, FILE)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut data = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut data)?;
    Ok(Some(data))
}

fn mirror(root: &Path, order: &ProjectOrder) -> Result<(), LofError> {
    atomic_write_bytes(
        &crate::sync::file_remote::safe_path(root, FILE)?,
        &bytes(order)?,
    )
}

pub(crate) fn load(root: &Path, db: &LibraryDb) -> Result<Option<ProjectOrder>, LofError> {
    let saved = stored(db)?;
    let legacy: Option<Vec<String>> = db
        .get("projectOrder")?
        .and_then(|value| serde_json::from_value(value).ok())
        .filter(|ids: &Vec<String>| valid_ids(ids));
    let mut local = saved.clone();
    if let Some(ids) = legacy.as_ref() {
        if saved.as_ref().is_none_or(|order| &order.ids != ids) {
            // 이전 앱에서 같은 DB의 순서를 바꾼 경우에도 변경을 이어받는다.
            local = Some(updated(ids.clone(), saved.as_ref(), saved.is_none()));
        }
    }
    let raw = file_bytes(root)?;
    let remote = raw.as_deref().and_then(parse);
    let selected = match (local, remote.clone()) {
        (Some(local), Some(remote)) => Some(newest(local, remote)),
        (local, remote) => local.or(remote),
    };
    if let Some(order) = &selected {
        if saved.as_ref() != Some(order) || legacy.as_ref() != Some(&order.ids) {
            save_db(db, order)?;
        }
        // 모르는 형식은 그대로 보관한다. 파일이 없는 구버전과 연결해도 DB 순서는 지우지 않는다.
        if (raw.is_none() || remote.is_some()) && remote.as_ref() != Some(order) {
            mirror(root, order)?;
        }
    }
    Ok(selected)
}

pub(crate) fn set(root: &Path, db: &LibraryDb, ids: Vec<String>) -> Result<(), LofError> {
    if !valid_ids(&ids) {
        return Err(fail_invalid("작품 순서 목록이 올바르지 않습니다."));
    }
    let previous = load(root, db)?;
    let order = updated(ids, previous.as_ref(), false);
    save_db(db, &order)?;
    mirror(root, &order)
}

pub(crate) fn receive(
    root: &Path,
    db: &LibraryDb,
    incoming: Option<&[u8]>,
) -> Result<bool, LofError> {
    let local = load(root, db)?;
    let remote = incoming.and_then(parse);
    if incoming.is_some() && remote.is_none() {
        return Ok(false);
    }
    let selected = match (local, remote) {
        (Some(local), Some(remote)) => Some(newest(local, remote)),
        (local, remote) => local.or(remote),
    };
    if let Some(order) = selected {
        save_db(db, &order)?;
        mirror(root, &order)?;
        return Ok(true);
    }
    Ok(false)
}

// 순서를 동시에 바꾸면 원고 충돌 사본을 만들지 않고 변경 시각과 식별자로 결정한다.
pub(crate) fn merge_bytes(local: Option<&[u8]>, remote: Option<&[u8]>) -> Option<Vec<u8>> {
    let left = local.and_then(parse);
    let right = remote.and_then(parse);
    if (local.is_some() && left.is_none()) || (remote.is_some() && right.is_none()) {
        return None;
    }
    let selected = match (left, right) {
        (Some(left), Some(right)) => Some(newest(left, right)),
        (left, right) => left.or(right),
    }?;
    bytes(&selected).ok()
}
