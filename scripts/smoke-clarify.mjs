// Create a project and wait for the first clarify round; prints the questions and the log summary.
const BASE = "http://localhost:8790";
const j = (m, p, b) => fetch(BASE + p, { method: m, headers: b ? { "Content-Type": "application/json" } : {}, body: b && JSON.stringify(b) }).then((r) => r.json());
const p = await j("POST", "/api/projects", { topic: process.argv[2] ?? "How CRISPR-Cas9 edits a gene", stylePreset: process.argv[3] ?? "scientific" });
for (;;) {
  const q = await j("GET", `/api/projects/${p.id}`);
  if (q.job?.status === "error") { console.log("ERROR", q.job.error); break; }
  if (q.job?.status === "done") { for (const x of q.clarify.at(-1).questions) console.log("Q:", x.question, x.options); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
for (const e of await j("GET", `/api/projects/${p.id}/log`)) console.log(e.type, e.stage ?? "", e.name ?? e.path ?? "", e.ms ?? "", e.cost ?? "", e.error ? "ERR " + e.error.slice(0, 200) : "");
console.log(p.id);
