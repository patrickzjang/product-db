"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/session", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (data?.authenticated) {
          router.replace("/");
          return;
        }
      } finally {
        setChecking(false);
      }
    };
    check();
  }, [router]);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error || "Login failed");
        return;
      }
      router.replace("/");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page login-page">
      <section className="panel login-panel">
        <div className="card auth-card login-card">
          <div className="login-brand">
            <img src="/assets/new-logo-2026.png" alt="Cloud Vision" className="login-logo" />
            <h1 className="login-title">Cloud Vision Product Management</h1>
            <p className="subtitle login-subtitle">Sign in to continue.</p>
          </div>
          {checking ? (
            <div className="status">Checking session...</div>
          ) : (
            <>
              <div className="auth-row login-row">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                  autoComplete="username"
                  disabled={loading}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button className="primary" onClick={login} disabled={loading}>
                  {loading ? "Signing in..." : "Login"}
                </button>
              </div>
              {error && <div className="status">{error}</div>}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
