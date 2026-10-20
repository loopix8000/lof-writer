const RELEASES_API = "https://api.github.com/repos/loopix8000/lof-writer/releases";

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  created_at: string;
  draft: boolean;
  prerelease: boolean;
};

export type Release = { version: string; name: string; body: string; date: string; prerelease: boolean };

async function request<T>(suffix: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await fetch(RELEASES_API + suffix, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 403 || response.status === 429)
      throw Error("요청이 많아 잠시 뒤에 다시 시도해 주세요.");
    if (response.status === 404) throw Error("해당 릴리즈를 찾을 수 없습니다.");
    if (!response.ok) throw Error(`응답 코드 ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw Error("요청 시간이 초과되었습니다.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

const toRelease = (release: GitHubRelease): Release => ({
  version: release.tag_name.slice(1),
  name: release.name || release.tag_name,
  body: release.body || "",
  date: release.published_at || release.created_at || "",
  prerelease: release.prerelease,
});

export async function fetchRelease(version: string, signal?: AbortSignal): Promise<Release> {
  const tag = `v${version.replace(/^v/, "")}`;
  const release = await request<GitHubRelease>(`/tags/${encodeURIComponent(tag)}`, signal);
  if (release.draft || release.tag_name !== tag) throw Error("해당 릴리즈를 찾을 수 없습니다.");
  return toRelease(release);
}

export async function fetchReleases(signal?: AbortSignal): Promise<Release[]> {
  const releases = await request<GitHubRelease[]>("?per_page=30", signal);
  return releases.filter(release => !release.draft && /^v\d/.test(release.tag_name)).map(toRelease);
}
