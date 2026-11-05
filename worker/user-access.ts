/** Role updates and outstanding-link revocation share a D1 transaction. */
export async function updateUserAccess(db: D1Database, id: string, change: { role?: string; active?: boolean }) {
  if (change.active !== undefined && typeof change.active !== "boolean") throw new Error("active must be boolean");
  if (change.role !== undefined && !["admin", "member", "viewer"].includes(change.role)) throw new Error("invalid role");
  const statements: D1PreparedStatement[] = [];
  if (change.role) statements.push(db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(change.role, id));
  if (change.active !== undefined) statements.push(db.prepare("UPDATE users SET active = ? WHERE id = ?").bind(change.active ? 1 : 0, id));
  if (change.active === false || change.role === "viewer") statements.push(db.prepare("DELETE FROM upload_links WHERE user_id = ?").bind(id));
  if (statements.length) await db.batch(statements);
}
