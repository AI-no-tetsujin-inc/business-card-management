import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { BottomSheet, confirmLeave, hasUnsaved, ToastProvider } from "./components/ui";
import { setCapturedFront } from "./lib/capture";
import { api } from "./api";
import { AuthContext, useAuth } from "./auth";
import type { Features, User } from "./types";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { CardsPage } from "./pages/Cards";
import { CompaniesPage } from "./pages/Companies";
import { UploadPage } from "./pages/Upload";
import { DraftsPage } from "./pages/Drafts";
import { DraftReviewPage } from "./pages/DraftReview";
import { CardDetailPage } from "./pages/CardDetail";
import { TrashPage } from "./pages/Trash";
import { ProfilePage } from "./pages/Profile";
import { AdminPage } from "./pages/Admin";
import { CustomerBillingPage } from "./pages/CustomerBilling";
import { InternalClaimsPage } from "./pages/InternalClaims";
import { ExpenseImportPage } from "./pages/ExpenseImport";
import { TaxExportPage } from "./pages/TaxExport";
import { PeoplePage } from "./pages/People";
import { SubscriptionsPage } from "./pages/Subscriptions";
import { TasksPage } from "./pages/Tasks";
import { MinutesDetailPage, MinutesPage } from "./pages/Minutes";
import { ReviewPage } from "./pages/Review";
import { MapPage } from "./pages/Map";
import { CompanyPage } from "./pages/Company";
import { UploadLinkPage } from "./pages/UploadLink";
import { getNext } from "./lib/next";

/** ログイン済みで /login?next=... に来た場合（AI 連携の許可画面へ戻る途中など） */
function LoginRedirect() {
  useEffect(() => {
    location.replace(getNext());
  }, []);
  return <div className="center-screen">移動しています…</div>;
}

/** スマホのメニューの説明（2行目に小さく出す） */
const MENU_SUB: Record<string, string> = {
  "/billing": "見積・契約・請求書",
  "/internal": "稼働分・立替経費",
  "/subscriptions": "サービスの契約",
  "/people": "立場・状況・性格のまとめ",
  "/upload": "写真から・まとめて",
  "/admin": "設定・利用状況",
  "/profile": " ",
};

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [features, setFeatures] = useState<Features>({ minutes: false, graph: false });
  const [pendingCount, setPendingCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  const refreshUser = useCallback(async () => {
    try {
      const r = await api<{ user: User; features?: Features }>("/api/me");
      setUser(r.user);
      setFeatures({ minutes: false, graph: false, ...r.features });
    } catch {
      setUser(null);
    }
  }, []);

  const refreshPending = useCallback(() => {
    api<{ count: number }>("/api/drafts/count").then((r) => setPendingCount(r.count), () => {});
    if (features.graph) api<{ count: number }>("/api/review/count").then((r) => setReviewCount(r.count), () => {});
  }, [features.graph]);

  useEffect(() => {
    if (!location.pathname.startsWith("/u/")) refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    if (user?.registered) refreshPending();
  }, [user, refreshPending]);

  // 画像アップロード用リンクはログイン不要
  if (location.pathname.startsWith("/u/")) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/u/:token" element={<UploadLinkPage />} />
        </Routes>
      </BrowserRouter>
    );
  }

  if (user === undefined) return <div className="center-screen">読み込み中…</div>;

  return (
    <BrowserRouter>
      {user === null ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : (
        <AuthContext.Provider value={{ user, features, refreshUser, pendingCount, reviewCount, refreshPending }}>
          <ToastProvider>
          {!user.registered ? (
            <RegisterPage />
          ) : (
            <Layout>
              <Routes>
                <Route path="/" element={<CardsPage />} />
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/drafts" element={<DraftsPage />} />
                <Route path="/drafts/:id" element={<DraftReviewPage />} />
                <Route path="/cards/:id" element={<CardDetailPage />} />
                <Route path="/trash" element={<TrashPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/billing" element={<CustomerBillingPage />} />
                <Route path="/internal" element={<InternalClaimsPage />} />
                <Route path="/internal/import" element={<ExpenseImportPage />} />
                <Route path="/internal/export" element={<TaxExportPage />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/subscriptions" element={<SubscriptionsPage />} />
                <Route path="/company" element={<CompanyPage />} />
                {/* 議事録・タスク（管理画面で有効にしたときだけ表示） */}
                {features.minutes && (
                  <>
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/minutes" element={<MinutesPage />} />
                    <Route path="/minutes/:id" element={<MinutesDetailPage />} />
                  </>
                )}
                {/* つながり・確認依頼はスコープ外（管理画面で有効にしたときだけ表示） */}
                {features.graph && (
                  <>
                    <Route path="/review" element={<ReviewPage />} />
                    <Route path="/map" element={<MapPage />} />
                  </>
                )}
                <Route path="/admin" element={user.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
                <Route path="/login" element={<LoginRedirect />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          )}
          </ToastProvider>
        </AuthContext.Provider>
      )}
    </BrowserRouter>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { user, features, pendingCount, reviewCount, refreshPending } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    refreshPending();
    setMenuOpen(false);
    // 名刺一覧はスクロール位置を自分で戻すので、それ以外の画面だけ先頭に戻す
    if (location.pathname !== "/") window.scrollTo(0, 0);
  }, [location.pathname, refreshPending]);

  // 保存していない入力があるときは、アプリ内のどのリンクで移動するときも確認する（メニュー・「← 一覧」など）
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!hasUnsaved() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement).closest("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const here = window.location;
      const url = new URL(a.href, here.href);
      if (url.origin !== here.origin || (url.pathname === here.pathname && url.search === here.search)) return;
      if (!confirmLeave()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const mainLinks = [
    { to: "/billing", label: "顧客請求" },
    { to: "/internal", label: "社内請求・経費" },
    { to: "/subscriptions", label: "契約・サブスク" },
    { to: "/people", label: "人物情報" },
    ...(features.minutes
      ? [
          { to: "/minutes", label: "議事録" },
          { to: "/tasks", label: "タスク" },
        ]
      : []),
    ...(features.graph
      ? [
          { to: "/map", label: "つながり" },
          { to: "/review", label: "確認依頼", badge: reviewCount },
        ]
      : []),
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="app-header">
        <div className="header-inner">
          <NavLink to="/" className="brand" aria-label="AIの鉄人 名刺管理（名刺一覧へ）">
            <img src="/logo-wide.png" alt="AIの鉄人" width="720" height="179" />
          </NavLink>
          <nav className="main-nav" aria-label="メインメニュー">
            <NavLink to="/" end>
              名刺
            </NavLink>
            <NavLink to="/companies">
              会社
            </NavLink>
            {mainLinks.map((l) => (
              <NavLink key={l.to} to={l.to}>
                {l.label}
                {l.badge ? <span className="badge">{l.badge}</span> : null}
              </NavLink>
            ))}
            <NavLink to="/upload">
              ＋登録
            </NavLink>
            <NavLink to="/drafts">
              確認待ち{pendingCount > 0 && <span className="badge" aria-label={`${pendingCount}件`}>{pendingCount}</span>}
            </NavLink>
          </nav>
          <nav className="sub-nav" aria-label="アカウント">
            {user.role === "admin" && (
              <NavLink to="/admin">
                管理
              </NavLink>
            )}
            <NavLink to="/profile" className="user-link">
              {user.name}
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="app-main" id="main">
        {children}
      </main>

      {/* スマホ: 下のタブ。撮影はどの画面からでもその場でカメラを起動する */}
      <nav className="tabbar" aria-label="メインメニュー（スマホ）">
        <NavLink to="/" end>
          名刺
        </NavLink>
        <NavLink to="/companies">
          会社
        </NavLink>
        {user.role !== "viewer" ? (
          <label className="tabbar-camera" aria-label="名刺を撮影して登録">
            <input
              type="file"
              accept="image/*,.heic,.heif"
              capture="environment"
              hidden
              onClick={(e) => {
                if (!confirmLeave()) e.preventDefault();
              }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setCapturedFront(f);
                navigate("/upload", { state: { captured: Date.now() } });
              }}
            />
            <span className="tabbar-camera-pill">撮影</span>
          </label>
        ) : (
          <span />
        )}
        <NavLink to="/drafts">
          確認待ち
          {pendingCount > 0 && <span className="badge tabbar-badge">{pendingCount}</span>}
        </NavLink>
        <button className={mainLinks.some((l) => location.pathname.startsWith(l.to)) || ["/admin", "/profile", "/upload"].includes(location.pathname) ? "active" : ""} onClick={() => setMenuOpen(true)} aria-haspopup="dialog">
          メニュー
        </button>
      </nav>
      <BottomSheet open={menuOpen} title="メニュー" onClose={() => setMenuOpen(false)}>
        <ul className="sheet-menu grouped-list">
          {[...mainLinks, { to: "/upload", label: "名刺を登録" }, ...(user.role === "admin" ? [{ to: "/admin", label: "管理" }] : []), { to: "/profile", label: "プロフィール" }].map((l) => (
            <li key={l.to}>
              <NavLink to={l.to}>
                <span className="row-text">
                  <span className="row-title">{l.label}</span>
                  {MENU_SUB[l.to] && <span className="row-sub">{l.to === "/profile" ? user.name : MENU_SUB[l.to]}</span>}
                </span>
                {"badge" in l && l.badge ? <span className="badge">{l.badge}</span> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </div>
  );
}
