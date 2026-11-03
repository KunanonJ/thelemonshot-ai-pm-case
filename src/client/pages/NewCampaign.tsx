import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Field, Input, Select } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { categoryLabel, fmtAgo } from "../lib/format";
import { useRouter } from "../lib/router";
import type { AttachableShortlist, Role } from "../types";

type Row = { url: string; handle: string; baselineViews: string; baselineEr: string };
const blank = (): Row => ({ url: "", handle: "", baselineViews: "", baselineEr: "" });
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10); // Bangkok date
const inDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// TikTok URLs carry the handle; Instagram and YouTube post URLs don't
const needsHandle = (url: string) => /instagram\.com|youtube\.com|youtu\.be/i.test(url);

export function NewCampaign({ role }: { role: Role }) {
  const api = useApi();
  const { navigate } = useRouter();
  const shortlists = useResource<AttachableShortlist[]>("/api/proposals/shortlists");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [matrixRunId, setMatrixRunId] = useState("");
  const [startsOn, setStartsOn] = useState(today());
  const [endsOn, setEndsOn] = useState(inDays(today(), 14));
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const filled = rows.filter((r) => r.url.trim());
  const update = (i: number, patch: Partial<Row>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

  async function submit() {
    setSubmitting(true);
    setError(null);
    setRowErrors({});
    const indexes = rows.map((r, i) => (r.url.trim() ? i : -1)).filter((i) => i >= 0);
    try {
      const { campaignId } = await api<{ campaignId: string }>("/api/campaigns", {
        method: "POST",
        body: {
          name,
          brand,
          matrixRunId: matrixRunId || undefined,
          startsOn,
          endsOn,
          posts: indexes.map((i) => ({
            url: rows[i]!.url.trim(),
            handle: rows[i]!.handle.trim() || undefined,
            baselineViews: num(rows[i]!.baselineViews),
            baselineEngagementRate: num(rows[i]!.baselineEr),
          })),
        },
      });
      navigate(`/campaigns/${campaignId}`);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { problems?: { index: number; error: string }[]; issues?: { message: string }[] }) : {};
      if (body.problems?.length) {
        setRowErrors(Object.fromEntries(body.problems.map((p) => [indexes[p.index]!, p.error])));
        setError("Some posts need a fix before the campaign can be registered.");
      } else setError(body.issues?.length ? body.issues.map((i) => i.message).join(". ") : "Couldn't register the campaign.");
      setSubmitting(false);
    }
  }

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Optimization", to: "/campaigns" }, { label: "New campaign" }]} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate("/campaigns")}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting || !name.trim() || !brand.trim() || filled.length === 0} onClick={() => void submit()}>
            {submitting ? "Registering" : "Register campaign"}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-3xl space-y-8 pb-16">
        <section className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Campaign</h1>
            <p className="text-[13px] text-neutral-500">Posts refresh daily during the flight and weekly after it ends, until you close the campaign.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Seaweed chips launch" />
            </Field>
            <Field label="Brand">
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
            </Field>
            <Field label="Starts">
              <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>
            <Field label="Ends">
              <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </Field>
          </div>
          <Field label="Creator shortlist (optional)" hint="Links the campaign to the Creator Matrix run its creators came from.">
            <Select value={matrixRunId} onChange={(e) => setMatrixRunId(e.target.value)}>
              <option value="">None</option>
              {(shortlists.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.brief?.brand || "Untitled brief"} · {s.brief ? categoryLabel(s.brief.productCategory) : ""} · {s.status} · {fmtAgo(s.createdAt)}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Tracked posts</h2>
            <p className="text-[13px] text-neutral-500">
              Paste post URLs. Instagram and YouTube URLs need the creator's handle. Baselines are what you expect; without them, posts are compared with their
              peers only.
            </p>
          </div>
          <div className="hidden grid-cols-[1fr_9rem_7rem_6rem_1.5rem] gap-2 text-xs text-neutral-500 sm:grid">
            <span>Post URL</span>
            <span>Handle</span>
            <span>Baseline views</span>
            <span>Baseline ER %</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i}>
              <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1fr_9rem_7rem_6rem_1.5rem]">
                <Input className="col-span-2 sm:col-span-1" aria-label="Post URL" value={r.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="https://www.tiktok.com/@creator/video/…" />
                <Input value={r.handle} onChange={(e) => update(i, { handle: e.target.value })} placeholder={needsHandle(r.url) ? "@needed" : "@optional"} />
                <Input type="number" min={0} aria-label="Baseline views" placeholder="Baseline views" value={r.baselineViews} onChange={(e) => update(i, { baselineViews: e.target.value })} />
                <Input type="number" min={0} step="0.1" aria-label="Baseline ER %" placeholder="Baseline ER %" value={r.baselineEr} onChange={(e) => update(i, { baselineEr: e.target.value })} />
                <button className="justify-self-start text-xs text-neutral-400 hover:text-red-700 sm:justify-self-auto" onClick={() => setRows((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : [blank()]))} aria-label="Remove row">
                  Remove
                </button>
              </div>
              {rowErrors[i] && <div className="mt-1 text-xs text-red-700">{rowErrors[i]}</div>}
            </div>
          ))}
          {rows.length < 50 && (
            <Button size="sm" onClick={() => setRows((cur) => [...cur, blank()])}>
              Add post
            </Button>
          )}
        </section>
        {error && <Banner tone="red" title={error} />}
      </div>
    </Shell>
  );
}
