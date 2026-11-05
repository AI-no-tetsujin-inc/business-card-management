import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../lib/format";
import { viaLabel } from "../lib/next";

interface Task {
  id: string;
  title: string;
  detail: string;
  assignee: string | null;
  assignee_name: string;
  due_on: string | null;
  status: "open" | "done";
  source: string;
  confidence: number | null;
  card_id: string | null;
  person_name: string | null;
  document_id: string | null;
  document_title: string | null;
}

const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function TasksPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [status, setStatus] = useState<"open" | "done">("open");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ title: "", assignee_user_id: user.id, due_on: "" });
  const [error, setError] = useState("");
  const readOnly = user.role === "viewer";

  const load = useCallback(() => {
    api<{ tasks: Task[] }>(`/api/tasks?scope=${scope}&status=${status}`).then((r) => setTasks(r.tasks), (e) => setError(errorMessage(e)));
  }, [scope, status]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ users: { id: string; name: string }[] }>("/api/users").then((r) => setUsers(r.users), () => {});
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    try {
      await api("/api/tasks", { body: form });
      setForm({ ...form, title: "", due_on: "" });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const toggle = async (t: Task) => {
    await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { done: t.status === "open" } });
    load();
  };

  return (
    <div className="page">
      <h1>タスク</h1>
      {!readOnly && (
        <form className="panel task-form" onSubmit={add}>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="やることを入力" />
          <select value={form.assignee_user_id} onChange={(e) => setForm({ ...form, assignee_user_id: e.target.value })} aria-label="担当">
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <input type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} aria-label="期限" />
          <button className="btn btn-primary" type="submit">
            追加
          </button>
        </form>
      )}
      <div className="toolbar">
        <div className="segmented">
          <button className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>
            自分
          </button>
          <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
            全員
          </button>
        </div>
        <div className="segmented">
          <button className={status === "open" ? "active" : ""} onClick={() => setStatus("open")}>
            未完了
          </button>
          <button className={status === "done" ? "active" : ""} onClick={() => setStatus("done")}>
            完了
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {tasks === null ? (
        <p className="muted">読み込み中…</p>
      ) : tasks.length === 0 ? (
        <div className="empty">タスクはありません。</div>
      ) : (
        <ul className="list">
          {tasks.map((t) => {
            const overdue = t.status === "open" && t.due_on && t.due_on < today();
            return (
              <li key={t.id} className="task-row">
                <input type="checkbox" checked={t.status === "done"} disabled={readOnly} onChange={() => toggle(t)} aria-label="完了" />
                <div className="list-main">
                  <div className={`list-title ${t.status === "done" ? "done" : ""}`}>{t.title}</div>
                  <div className="list-meta">
                    {t.assignee || t.assignee_name || "担当未定"}
                    {t.due_on && <span className={overdue ? "error" : ""}> ・ 期限 {fmtDate(t.due_on)}</span>}
                    {t.person_name && (
                      <>
                        {" ・ "}
                        <Link to={`/cards/${t.card_id}`}>{t.person_name}</Link>
                      </>
                    )}
                    {t.document_title && (
                      <>
                        {" ・ 議事録 "}
                        <Link to={`/minutes/${t.document_id}`}>{t.document_title}</Link>
                      </>
                    )}
                    {viaLabel(t.source) && ` ・ ${viaLabel(t.source)}`}
                  </div>
                </div>
                {t.confidence !== null && t.confidence < 0.7 && <span className="pill pill-warn">要確認</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
