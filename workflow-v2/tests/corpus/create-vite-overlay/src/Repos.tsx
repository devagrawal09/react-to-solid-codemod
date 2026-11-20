import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Folder, RefreshCw, Star, type LucideIcon } from 'lucide-react'

type Repo = { id: number; name: string; stars: number }

async function fetchRepos(owner: string): Promise<Repo[]> {
  const response = await fetch(`https://api.github.com/users/${owner}/repos`)
  const repos: { id: number; name: string; stargazers_count: number }[] = await response.json()
  return repos.map((repo) => ({ id: repo.id, name: repo.name, stars: repo.stargazers_count }))
}

function Badge({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="badge">
      <Icon size={14} />
      {label}
    </span>
  )
}

export function Repos({ owner, tags = [] }: { owner: string; tags?: string[] }) {
  const [minStars, setMinStars] = useState(0)
  const { data, isPending, refetch } = useQuery({ queryKey: ['repos', owner], queryFn: () => fetchRepos(owner) })
  const visible = useMemo(() => (data ?? []).filter((repo) => repo.stars >= minStars), [data, minStars])

  if (isPending) return <p>Loading…</p>
  return (
    <section>
      <h2>
        <Folder /> {owner} ({tags.join(', ')})
      </h2>
      <label htmlFor="min-stars">Min stars</label>
      <input id="min-stars" type="number" value={minStars} onChange={(e) => setMinStars(Number(e.target.value))} />
      <button type="button" onClick={() => refetch()}>
        <RefreshCw size={16} /> Refresh
      </button>
      <ul>
        {visible.map((repo) => (
          <li key={repo.id}>
            {repo.name} <Badge icon={Star} label={String(repo.stars)} />
          </li>
        ))}
      </ul>
    </section>
  )
}
