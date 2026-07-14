import type { BuildingFeature } from '../types'
import { setWikidataPhoto, setWikidataStyle } from './recognizer'

// Async recognizer prepass: for the (few) wikidata-linked landmark buildings,
// fetch the Wikidata architectural style (P149) and a reference photo (P18)
// BEFORE the synchronous scene build, then cache them so recognizeBuilding can
// read them without blocking. Best-effort: any failure leaves the building on
// the priors-only path — a build never blocks on Wikidata.

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

const ENTITYDATA = (qid: string) => `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`

interface Extracted {
  qid: string
  styleQid?: string
  photoUrl?: string
}

/** Read P149 (architectural style QID) and P18 (image filename) from an entity blob. */
function extract(qid: string, data: any): Extracted {
  const claims = data?.entities?.[qid]?.claims ?? {}
  const styleQid: string | undefined =
    claims.P149?.[0]?.mainsnak?.datavalue?.value?.id
  const imageFile: string | undefined = claims.P18?.[0]?.mainsnak?.datavalue?.value
  return {
    qid,
    styleQid,
    photoUrl: imageFile
      ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}?width=640`
      : undefined,
  }
}

/** Resolve architectural-style QIDs → English labels in one batched call. */
async function resolveStyleLabels(styleQids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(styleQids)]
  if (!unique.length) return out
  try {
    const url =
      `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*` +
      `&props=labels&languages=en&ids=${unique.join('|')}`
    const res = await withTimeout(fetch(url), 6000)
    const d = await res.json()
    for (const qid of unique) {
      const label = d?.entities?.[qid]?.labels?.en?.value
      if (label) out.set(qid, label)
    }
  } catch {
    /* leave labels unresolved — buildings fall back to priors */
  }
  return out
}

/**
 * Prefetch Wikidata style + photo for wikidata-linked buildings. Caps the
 * number of network calls (landmarks are few; a dense city center could still
 * have dozens) and reports progress via onStatus.
 */
export async function prefetchRecognizerData(
  buildings: BuildingFeature[],
  onStatus?: (m: string) => void,
  maxLookups = 40,
): Promise<void> {
  const linked = buildings.filter((b) => b.wikidata).slice(0, maxLookups)
  if (!linked.length) return
  onStatus?.('Recognizer: reading Wikidata architectural styles…')

  const extracted = await Promise.all(
    linked.map((b) =>
      withTimeout(fetch(ENTITYDATA(b.wikidata!)), 6000)
        .then((r) => r.json())
        .then((d) => extract(b.wikidata!, d))
        .catch(() => ({ qid: b.wikidata! }) as Extracted),
    ),
  )

  const styleLabels = await resolveStyleLabels(
    extracted.map((e) => e.styleQid).filter((q): q is string => !!q),
  )

  for (const e of extracted) {
    setWikidataStyle(e.qid, e.styleQid ? styleLabels.get(e.styleQid) ?? null : null)
    setWikidataPhoto(e.qid, e.photoUrl ?? null)
  }
}
