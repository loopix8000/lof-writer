//! 읽기 실패와 삭제를 구분하고 영향받는 경로만 보류한다.
use std::collections::{BTreeSet, HashSet};

/// 비교할 수 없는 경로를 삭제로 해석하지 않고 이전 동기화 기록을 보존한다.
#[derive(Default)]
pub struct DeferredPaths {
    paths: BTreeSet<String>,
}

impl DeferredPaths {
    pub fn insert(&mut self, path: &str) -> bool {
        // 작품 정보가 불완전하면 그 작품의 파일을 서로 다른 작품으로 오인하지 않는다.
        self.paths.insert(
            path.strip_suffix("/project.json")
                .unwrap_or(path)
                .to_string(),
        )
    }

    fn covers(&self, path: &str) -> bool {
        self.paths.iter().any(|deferred| {
            path == deferred
                || path
                    .strip_prefix(deferred)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    pub fn contains(&self, path: &str) -> bool {
        if self.covers(path) {
            return true;
        }
        self.paths.iter().any(|deferred| {
            // 보류 중인 원고가 고립되지 않도록 작품 정보도 함께 보존한다.
            path.strip_suffix("/project.json").is_some_and(|folder| {
                deferred
                    .strip_prefix(folder)
                    .is_some_and(|rest| rest.starts_with('/'))
            })
        })
    }

    pub fn protect_identities(&mut self, identities: &[(&str, &str)]) {
        loop {
            let protected: HashSet<_> = identities
                .iter()
                .filter(|(path, _)| self.covers(path))
                .map(|(_, id)| *id)
                .collect();
            let mut changed = false;
            for (path, id) in identities {
                if protected.contains(id) {
                    changed |= self.insert(path);
                }
            }
            if !changed {
                break;
            }
        }
    }
}
