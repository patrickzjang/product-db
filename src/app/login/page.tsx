"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("509040");
  const [password, setPassword] = useState("509040");
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
    <main className="page">
      <section className="panel">
        <div className="card auth-card">
          <h2>Login</h2>
          <p className="subtitle">Enter your account to continue.</p>
          {checking ? (
            <div className="status">Checking session...</div>
          ) : (
            <>
              <div className="auth-row">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                  disabled={loading}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
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
