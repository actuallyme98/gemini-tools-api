import type { AgentStore } from './agent.store';
import type { Project, Knowledge } from './workspace.types';

export async function retrieveKnowledge(
  store: AgentStore,
  owner: string,
  query: string,
  projectId?: string,
) {
  const project = projectId
    ? await store.find<Project>('project', projectId)
    : undefined;
  const allowed = project?.memberIds.includes(owner) ? [project.id] : [];
  const terms = [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    ),
  ].slice(0, 30);
  if (!terms.length) return [];
  const candidates = await store.knowledgeSearch(
    owner,
    allowed,
    terms.join(' '),
  );
  let remaining = 8000;
  return candidates.flatMap((document: Knowledge) => {
    if (remaining <= 0) return [];
    const text = document.content;
    const at = Math.max(
      0,
      terms
        .map((t) => text.toLowerCase().indexOf(t))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0] - 200 || 0,
    );
    const excerpt = text.slice(at, at + Math.min(1600, remaining));
    remaining -= excerpt.length;
    return [
      {
        id: document.id,
        title: document.title,
        revision: document.revision,
        excerpt,
      },
    ];
  });
}
