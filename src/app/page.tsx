"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MAX_BYTES,
  VARIATION_COLUMN,
} from "@/lib/config";

const BRAND_LIST = ["PAN", "ARENA", "DAYBREAK", "HEELCARE"] as const;

type Brand = (typeof BRAND_LIST)[number];

type FileItem = {
  file: File;
  sku: string | null;
  message: string;
  state: "" | "ok" | "error";
  uploaded: boolean;
};

type ImageRef = { name: string; url: string };

type Row = Record<string, any>;
const HIDDEN_SEARCH_COLUMNS = new Set(["CBV", "VAT", "COST", "MONTH", "BARCODE"]);
type MasterUploadResult = {
  file: string;
  brand?: string;
  status: "imported" | "skipped" | "error";
  total?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  reason?: string;
  error?: string;
  archive_bucket?: string;
  archive_path?: string;
  state_warning?: string;
};

function getVisibleTableHeaders(row: Row): string[] {
  const headers = Object.keys(row).filter(
    (h) => h !== "product_images" && !HIDDEN_SEARCH_COLUMNS.has(h)
  );
  const brandIdx = headers.indexOf("BRAND");
  if (brandIdx > 0) {
    headers.splice(brandIdx, 1);
    headers.unshift("BRAND");
  }
  return headers;
}

function getHeaderWidth(header: string): string {
  const chars = Math.max(8, header.length + 2);
  return `${chars}ch`;
}

function parseSku(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "");
  const idx = base.lastIndexOf("_");
  if (idx === -1) return null;
  const sku = base.slice(0, idx).trim();
  if (!sku) return null;
  return sku;
}

function withCacheBuster(url: string, version: number): string {
  return url.includes("?") ? `${url}&v=${version}` : `${url}?v=${version}`;
}

async function fetchJsonWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const payload = await res.json().catch(() => null);
    return { res, payload };
  } finally {
    window.clearTimeout(timer);
  }
}

export default function Home() {
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [status, setStatus] = useState("Waiting for files.");
  const [searchStatus, setSearchStatus] = useState("No search yet.");
  const [searchInput, setSearchInput] = useState("");
  const [currentBrand, setCurrentBrand] = useState<Brand>("PAN");
  const [activeTab, setActiveTab] = useState<"upload" | "master" | "search">("upload");
  const [pageSize, setPageSize] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [imageMap, setImageMap] = useState<Map<string, ImageRef[]>>(new Map());
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalImages, setModalImages] = useState<ImageRef[]>([]);
  const [modalTitle, setModalTitle] = useState("Images");
  const [isMobile, setIsMobile] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [masterFiles, setMasterFiles] = useState<File[]>([]);
  const [masterStatus, setMasterStatus] = useState("Waiting for master file upload.");
  const [masterUploading, setMasterUploading] = useState(false);
  const [masterProgressOpen, setMasterProgressOpen] = useState(false);
  const [masterProgressPercent, setMasterProgressPercent] = useState(0);
  const [masterProgressLabel, setMasterProgressLabel] = useState("");
  const [masterSummaryOpen, setMasterSummaryOpen] = useState(false);
  const [masterResults, setMasterResults] = useState<MasterUploadResult[]>([]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch("/api/session", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        const ok = Boolean(data?.authenticated);
        setIsAuthenticated(ok);
        if (!ok) {
          router.replace("/login");
        }
      } catch {
        setIsAuthenticated(false);
        router.replace("/login");
      } finally {
        setAuthChecking(false);
      }
    };
    checkSession();
  }, [router]);

  const grouped = useMemo(() => groupByVariationSku(rows), [rows]);
  const sortedRows = useMemo(() => sortRows(grouped.list, sortKey, sortDir), [grouped.list, sortKey, sortDir]);

  const handleFiles = (incoming: FileList | File[]) => {
    const selected = Array.from(incoming);
    setFiles((prev) => {
      const next = [...prev];
      for (const file of selected) {
        const sku = parseSku(file.name);
        let message = "Ready";
        let state: FileItem["state"] = "";
        if (!(file.type === "image/jpeg" || file.name.toLowerCase().endsWith(".jpg") || file.name.toLowerCase().endsWith(".jpeg"))) {
          message = "Only JPG allowed";
          state = "error";
        } else if (file.size > MAX_BYTES) {
          message = "Over 2MB";
          state = "error";
        } else if (!sku) {
          message = "Name must be SKU_*.jpg";
          state = "error";
        }
        next.push({ file, sku, message, state, uploaded: false });
      }
      return next;
    });
    setStatus(`${selected.length} file(s) added.`);
  };

  const clearAll = () => {
    setFiles([]);
    setStatus("Waiting for files.");
  };

  const uploadFile = useCallback(async (item: FileItem) => {
    if (item.state === "error" || !item.sku) return;

    item.message = "Uploading...";
    setFiles((prev) => [...prev]);

    const form = new FormData();
    form.append("file", item.file);
    form.append("sku", item.sku);
    form.append("brand", currentBrand);

    const uploadRes = await fetch("/api/upload", {
      method: "POST",
      body: form,
    });

    const uploadJson = await uploadRes.json().catch(() => null);
    if (uploadRes.status === 401) {
      setIsAuthenticated(false);
      router.replace("/login");
      item.message = "Please login first";
      item.state = "error";
      setFiles((prev) => [...prev]);
      return;
    }
    if (!uploadRes.ok) {
      item.message = `Upload failed: ${uploadJson?.error || uploadRes.statusText}`;
      item.state = "error";
      setFiles((prev) => [...prev]);
      return;
    }

    item.message = "Uploaded";
    item.state = "ok";
    item.uploaded = true;
    setFiles((prev) => [...prev]);
  }, [currentBrand, router]);

  const uploadAll = async () => {
    setStatus("Uploading...");
    for (const item of files) {
      try {
        await uploadFile(item);
      } catch (err: any) {
        item.message = err?.message ?? "Unexpected error";
        item.state = "error";
        setFiles((prev) => [...prev]);
      }
    }
    setStatus("Done.");
  };

  const uploadMasterFiles = async () => {
    if (masterFiles.length === 0 || masterUploading) return;
    setMasterUploading(true);
    setMasterProgressOpen(true);
    setMasterProgressPercent(0);
    setMasterProgressLabel("Preparing upload...");
    setMasterStatus("Uploading master files...");
    const results: MasterUploadResult[] = [];

    for (let idx = 0; idx < masterFiles.length; idx += 1) {
      const file = masterFiles[idx];
      const totalFiles = masterFiles.length;
      const basePercent = (idx / totalFiles) * 100;
      const endPercent = ((idx + 1) / totalFiles) * 100;
      let visualPercent = basePercent;
      const capPercent = Math.max(basePercent, endPercent - 1);
      setMasterProgressLabel(`Processing ${idx + 1}/${totalFiles}: ${file.name}`);
      setMasterStatus(`Processing ${idx + 1}/${totalFiles}: ${file.name}`);
      setMasterProgressPercent(Math.round(basePercent));
      const ticker = window.setInterval(() => {
        const remaining = capPercent - visualPercent;
        const step = remaining > 20 ? 2 : remaining > 8 ? 1.1 : 0.4;
        visualPercent = Math.min(capPercent, visualPercent + step);
        setMasterProgressPercent(Math.round(visualPercent));
      }, 220);

      try {
        const form = new FormData();
        form.append("file", file);
        const { res, payload } = await fetchJsonWithTimeout(
          "/api/master-upload",
          { method: "POST", body: form },
          240000
        );
        if (res.status === 401) {
          setIsAuthenticated(false);
          router.replace("/login");
          results.push({ file: file.name, status: "error", error: "Please login first" });
          setMasterProgressPercent(Math.round(endPercent));
          break;
        }
        if (!res.ok) {
          results.push({ file: file.name, status: "error", error: payload?.error || res.statusText });
          setMasterProgressPercent(Math.round(endPercent));
          continue;
        }
        results.push({
          file: file.name,
          brand: payload?.brand,
          status: payload?.status || "imported",
          total: payload?.total,
          inserted: payload?.inserted,
          updated: payload?.updated,
          unchanged: payload?.unchanged,
          reason: payload?.reason,
          archive_bucket: payload?.archive_bucket,
          archive_path: payload?.archive_path,
          state_warning: payload?.state_warning,
        });
        setMasterProgressPercent(Math.round(endPercent));
      } catch (err: any) {
        const message = err?.name === "AbortError"
          ? "Request timed out after 4 minutes. Please check summary and refresh."
          : err?.message || "Unexpected error";
        results.push({ file: file.name, status: "error", error: message });
        setMasterProgressPercent(Math.round(endPercent));
      } finally {
        window.clearInterval(ticker);
      }
    }

    setMasterProgressPercent(100);
    setMasterProgressLabel("Finalizing...");
    setMasterResults(results);
    setMasterSummaryOpen(true);
    setTimeout(() => setMasterProgressOpen(false), 220);
    const okCount = results.filter((r) => r.status !== "error").length;
    setMasterStatus(`Finished: ${okCount}/${results.length} file(s) processed.`);
    setMasterUploading(false);
  };

  const buildImageMap = (data: Row[], cacheVersion: number) => {
    const map = new Map<string, ImageRef[]>();
    for (const row of data) {
      const sku = row[VARIATION_COLUMN];
      if (!sku) continue;
      const imgs = row.product_images;
      if (Array.isArray(imgs)) {
        map.set(
          String(sku),
          imgs.map((url: string) => {
            const cleanUrl = String(url).split("?")[0];
            return {
              name: cleanUrl.split("/").pop() || cleanUrl,
              url: withCacheBuster(String(url), cacheVersion),
            };
          })
        );
      } else {
        map.set(String(sku), []);
      }
    }
    return map;
  };

  const runSearch = useCallback(async () => {
    const q = searchInput.trim();

    setSearchStatus("Searching...");

    try {
      const searchRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: currentBrand,
          query: q,
          pageSize,
          currentPage,
        }),
      });

      const payload = await searchRes.json().catch(() => null);
      if (searchRes.status === 401) {
        setIsAuthenticated(false);
        router.replace("/login");
        throw new Error("Please login first");
      }
      if (!searchRes.ok) {
        throw new Error(payload?.error || searchRes.statusText);
      }

      const dataRows = Array.isArray(payload?.rows) ? payload.rows : [];
      const total = Number(payload?.total) || 0;
      const nextPageCount = Number(payload?.pageCount) || 1;
      const shown = Number(payload?.shown) || 0;

      if (dataRows.length === 0) {
        setRows([]);
        setImageMap(new Map());
        setPageCount(nextPageCount);
        setSearchStatus(`${total || 0} total, 0 shown.`);
        return;
      }

      const map = buildImageMap(dataRows, Date.now());
      setRows(dataRows);
      setImageMap(map);
      setSearchStatus(`${total || 0} total, ${shown} shown.`);
      setPageCount(nextPageCount);
    } catch (err: any) {
      setSearchStatus(`Search failed: ${err?.message ?? "Unknown error"}`);
    }
  }, [searchInput, currentPage, pageSize, currentBrand, router]);

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
    setIsAuthenticated(false);
    router.replace("/login");
  };

  useEffect(() => {
    if (activeTab === "search") {
      runSearch();
    }
  }, [activeTab, currentPage, pageSize, currentBrand, runSearch]);

  const openModal = (variation: string, images: ImageRef[]) => {
    setModalTitle(`Images for ${variation}`);
    setModalImages(images);
    setModalOpen(true);
  };

  const downloadUrl = async (url: string, filename: string) => {
    const safeName = filename || "image.jpg";
    const trigger = (href: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = safeName;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      a.remove();
    };

    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
      if (!res.ok) {
        throw new Error(res.statusText || "Download request failed");
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      trigger(objectUrl);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const downloadAll = async (images: ImageRef[]) => {
    for (const img of images) {
      await downloadUrl(img.url, img.name);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const closeDownloadMenu = (el: HTMLElement) => {
    const details = el.closest("details");
    if (details instanceof HTMLDetailsElement) {
      details.open = false;
    }
  };

  if (authChecking) {
    return (
      <main className="page">
        <section className="panel">
          <div className="card">
            <h2>Loading</h2>
            <div className="status">Checking session...</div>
          </div>
        </section>
      </main>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const toCsv = (dataRows: Row[], imgMap: Map<string, ImageRef[]>) => {
    if (!dataRows || dataRows.length === 0) return "";
    const headers = [...Object.keys(dataRows[0]).filter((h) => h !== "product_images"), "PROD_JPG"];
    const esc = (v: any) => {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [
      headers.map(esc).join(","),
      ...dataRows.map((r) => {
        const variation = r[VARIATION_COLUMN];
        const images = imgMap.get(String(variation)) || [];
        const firstUrl = images[0]?.url ?? "";
        return headers
          .map((h) => {
            if (h === "PROD_JPG") return esc(firstUrl);
            return esc(r[h]);
          })
          .join(",");
      }),
    ];
    return lines.join("\n");
  };

  const downloadCsv = () => {
    const csv = toCsv(rows, imageMap);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "products.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const renderTable = () => {
    if (sortedRows.length === 0) return null;
    const headers = getVisibleTableHeaders(sortedRows[0]);
    const headerWidths = Object.fromEntries(headers.map((h) => [h, getHeaderWidth(h)]));

    if (isMobile) {
      return (
        <div className="mobile-cards">
          {sortedRows.map((row) => {
            const variation = row[VARIATION_COLUMN];
            const groupRows = grouped.map.get(variation) || [row];
            const images = imageMap.get(String(variation)) || [];
            const img = images.find((i) => /_out\./i.test(i.name)) || images[0];

            return (
              <div className="mobile-card" key={variation}>
                <div className="mobile-card-header">
                  <div className="mobile-card-title">VARIATION_SKU:<br />{variation}</div>
                </div>
                <div className="mobile-card-image">
                  <div className="mobile-image-col">
                    {img ? (
                      <>
                        <img
                          src={img.url}
                          alt={img.name}
                          className="thumb"
                          onClick={() => openModal(String(variation), images)}
                        />
                        <details className="download-menu" onClick={(e) => e.stopPropagation()}>
                          <summary className="ghost download-trigger">Download ▾</summary>
                          <div className="download-pop">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadUrl(img.url, img.name);
                                closeDownloadMenu(e.currentTarget);
                              }}
                            >
                              First image
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadAll(images);
                                closeDownloadMenu(e.currentTarget);
                              }}
                            >
                              All images
                            </button>
                          </div>
                        </details>
                      </>
                    ) : (
                      <div>No image</div>
                    )}
                  </div>
                </div>
                <button
                  className="ghost"
                  onClick={() => {
                    const next = new Set(expandedRows);
                    if (next.has(variation)) next.delete(variation);
                    else next.add(variation);
                    setExpandedRows(next);
                  }}
                >
                  {expandedRows.has(variation) ? "Hide Details" : "Show Details"}
                </button>
                {expandedRows.has(variation) && (
                  <div className="mobile-card-details">
                    {groupRows.map((item, idx) => (
                      <div className="mobile-card-row" key={`${variation}-${idx}`}>
                        {headers.map((h) => (
                          <div className="mobile-card-field" key={h}>
                            <div className="label">{h}</div>
                            <div className="value">{item[h] ?? ""}</div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <table className="results-table">
        <thead>
          <tr>
            <th></th>
            {headers.map((h) => (
              <th
                key={h}
                className="sortable"
                style={{ width: headerWidths[h], minWidth: headerWidths[h] }}
                data-sort={sortKey === h ? sortDir : undefined}
                onClick={() => {
                  if (sortKey === h) setSortDir(sortDir === "asc" ? "desc" : "asc");
                  else {
                    setSortKey(h);
                    setSortDir("asc");
                  }
                }}
              >
                {h}
              </th>
            ))}
            <th className="thumb-col">PROD_JPG</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, idx) => {
            const variation = row[VARIATION_COLUMN];
            const groupRows = grouped.map.get(variation) || [row];
            const images = imageMap.get(String(variation)) || [];
            const img = images.find((i) => /_out\./i.test(i.name)) || images[0];

            return (
              <Fragment key={variation}>
                <tr>
                  <td className="arrow-cell">
                    {((currentPage - 1) * pageSize) + idx + 1}. {" "}
                    <span
                      className="row-toggle"
                      onClick={() => {
                        const next = new Set(expandedRows);
                        if (next.has(variation)) next.delete(variation);
                        else next.add(variation);
                        setExpandedRows(next);
                      }}
                    >
                      {expandedRows.has(variation) ? "▾" : "▸"}
                    </span>
                  </td>
                  {headers.map((h) => (
                    <td key={h} style={{ width: headerWidths[h], minWidth: headerWidths[h] }}>{row[h] ?? ""}</td>
                  ))}
                  <td className="thumb-wrap thumb-col">
                    {img ? (
                      <>
                        <img
                          src={img.url}
                          alt={img.name}
                          className="thumb"
                          onClick={() => openModal(String(variation), images)}
                        />
                        <details className="download-menu" onClick={(e) => e.stopPropagation()}>
                          <summary className="ghost download-trigger">Download ▾</summary>
                          <div className="download-pop">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadUrl(img.url, img.name);
                                closeDownloadMenu(e.currentTarget);
                              }}
                            >
                              First image
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadAll(images);
                                closeDownloadMenu(e.currentTarget);
                              }}
                            >
                              All images
                            </button>
                          </div>
                        </details>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                {expandedRows.has(variation) &&
                  groupRows.map((item, i) => (
                    <tr key={`${variation}-${i}`} className="sub-row">
                      <td className="thumb-col"></td>
                      {headers.map((h) => (
                        <td key={`${h}-${i}`} style={{ width: headerWidths[h], minWidth: headerWidths[h] }}>{item[h] ?? ""}</td>
                      ))}
                      <td></td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="/assets/new-logo-2026.png" alt="Cloud Vision" className="logo" />
          <div className="brand-text">
            <div className="brand-title">Cloud Vision Product Management</div>
            <div className="brand-sub">Product images & master data</div>
          </div>
        </div>
      </header>

      <main className="page">
        <section className="panel">
          <div className="auth-row">
            <button className="ghost" onClick={logout}>Logout</button>
          </div>

          <div className="brand-tabs">
            {BRAND_LIST.map((b) => (
              <button
                key={b}
                className={`brand-tab ${currentBrand === b ? "active" : ""}`}
                onClick={() => {
                  setCurrentBrand(b);
                  setCurrentPage(1);
                  setSearchStatus("No search yet.");
                  setRows([]);
                }}
              >
                {b}
              </button>
            ))}
          </div>

          <div className="tabs">
            <button className={`tab ${activeTab === "upload" ? "active" : ""}`} onClick={() => setActiveTab("upload")}>Image Uploader</button>
            <button className={`tab ${activeTab === "master" ? "active" : ""}`} onClick={() => setActiveTab("master")}>Master Data Update</button>
            <button className={`tab ${activeTab === "search" ? "active" : ""}`} onClick={() => setActiveTab("search")}>Search Products</button>
          </div>

          {activeTab === "upload" && (
            <div className="card">
              <h2>Product Image Uploader</h2>
              <p className="subtitle">Drop JPG files named like <code>SKU_1.jpg</code>, <code>SKU_2.jpg</code>. The SKU must exist in <code>core.master_pan</code>.</p>

              <div
                id="dropzone"
                className="dropzone"
                aria-label="File dropzone"
                tabIndex={0}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFiles(e.dataTransfer.files);
                }}
              >
                <div className="dz-title">Drop files here</div>
                <div className="dz-sub">or click to choose files</div>
                <input id="fileInput" type="file" accept="image/jpeg" multiple onChange={(e) => handleFiles(e.target.files || [])} />
              </div>

              <div className="actions">
                <button className="primary" disabled={files.length === 0} onClick={uploadAll}>Upload</button>
                <button className="ghost" disabled={files.length === 0} onClick={clearAll}>Clear</button>
              </div>

              <div className="meta">
                <div>Max size: 2MB per image</div>
                <div>Format: JPG only</div>
              </div>

              <div className="status-inline">
                <div className="status-title">Status</div>
                <div className="status">{status}</div>
              </div>

              <ul className="file-list">
                {files.map((f, idx) => (
                  <li key={`${f.file.name}-${idx}`} className={`file-item ${f.state}`}>
                    <div className="name">{f.file.name}</div>
                    <div className="status">{f.message}</div>
                  </li>
                ))}
              </ul>

            </div>
          )}

          {activeTab === "master" && (
            <div className="card">
              <h2>Master Data Update</h2>
              <p className="subtitle">Upload CSV/XLS/XLSX named like <code>MASTER_PAN_DDMMYY.csv</code>. New version only, merge mode (insert new + update changed fields).</p>
              <div className="template-guide">
                <div className="template-guide-title">Template Guide</div>
                <div className="template-guide-sub">
                  Download blank template (headers only), fill rows, then rename file to
                  {" "}
                  <code>MASTER_(PAN|ARENA|DAYBREAK|HEELCARE)_DDMMYY</code>.
                </div>
                <div className="template-actions">
                  <a className="ghost template-link" href="/templates/MASTER_TEMPLATE.csv" download>
                    Download CSV Template
                  </a>
                  <a className="ghost template-link" href="/templates/MASTER_TEMPLATE.xlsx" download>
                    Download XLSX Template
                  </a>
                </div>
              </div>
              <div className="actions">
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  multiple
                  onChange={(e) => setMasterFiles(Array.from(e.target.files || []))}
                />
                <button className="primary" disabled={masterFiles.length === 0 || masterUploading} onClick={uploadMasterFiles}>
                  {masterUploading ? "Uploading..." : "Upload Master Files"}
                </button>
                <button className="ghost" disabled={masterUploading || masterFiles.length === 0} onClick={() => setMasterFiles([])}>
                  Clear
                </button>
              </div>
              <div className="status">{masterStatus}</div>
              {masterFiles.length > 0 && (
                <ul className="file-list">
                  {masterFiles.map((f) => (
                    <li key={f.name} className="file-item">
                      <div className="name">{f.name}</div>
                      <div className="status">{(f.size / 1024).toFixed(1)} KB</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {activeTab === "search" && (
            <div className="card">
              <h2>Search Products</h2>
              <p className="subtitle">Search by VARIATION_SKU (supports 1–9 characters, prefix match).</p>
              <div className="search-row">
                <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Enter VARIATION_SKU (leave blank for all)..." />
                <select className="select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                </select>
                <button className="primary" onClick={() => { setCurrentPage(1); runSearch(); }}>Search</button>
                <button className="ghost" disabled={rows.length === 0} onClick={downloadCsv}>Export CSV</button>
              </div>
              <div className="pager">
                <button className="ghost" disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>Prev</button>
                <div className="pager-info">Page {currentPage} / {pageCount}</div>
                <button className="ghost" disabled={currentPage >= pageCount} onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}>Next</button>
                <select className="select" value={currentPage} onChange={(e) => setCurrentPage(Number(e.target.value))}>
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p}>Page {p}</option>
                  ))}
                </select>
              </div>
              <div className="status">{searchStatus}</div>
              <div id="results">{renderTable()}</div>
            </div>
          )}
        </section>
      </main>

      {modalOpen && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="modal-backdrop" onClick={() => setModalOpen(false)}></div>
          <div className="modal-content">
            <div className="modal-header">
              <div id="modalTitle" className="modal-title">{modalTitle}</div>
              <button className="ghost" onClick={() => setModalOpen(false)}>Close</button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: 10 }}>
                <button className="ghost" onClick={() => downloadAll(modalImages)}>Download all images</button>
              </div>
              <div className="thumb-grid">
                {modalImages.map((img) => (
                  <div className="thumb-card" key={img.url}>
                    <img src={img.url} alt={img.name} className="thumb" />
                    <div>{img.name}</div>
                    <button className="ghost" onClick={() => downloadUrl(img.url, img.name)}>Download</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {masterSummaryOpen && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="masterSummaryTitle">
          <div className="modal-backdrop" onClick={() => setMasterSummaryOpen(false)}></div>
          <div className="modal-content">
            <div className="modal-header">
              <div id="masterSummaryTitle" className="modal-title">Master Upload Summary</div>
              <button className="ghost" onClick={() => setMasterSummaryOpen(false)}>Close</button>
            </div>
            <div className="modal-body">
              <ul className="file-list">
                {masterResults.map((r, i) => (
                  <li key={`${r.file}-${i}`} className={`file-item ${r.status === "error" ? "error" : r.status === "imported" ? "ok" : ""}`}>
                    <div className="name">{r.file}</div>
                    <div className="status">
                      {r.status === "imported" && `Imported (${r.brand || "-"}): total=${r.total || 0}, inserted=${r.inserted || 0}, updated=${r.updated || 0}, unchanged=${r.unchanged || 0}`}
                      {r.status === "skipped" && `Skipped: ${r.reason || "Not newer version"}`}
                      {r.status === "error" && `Error: ${r.error || "Unknown error"}`}
                      {r.status !== "error" && r.archive_bucket && r.archive_path && ` | Archived: ${r.archive_bucket}/${r.archive_path}`}
                      {r.status !== "error" && r.state_warning && ` | Warning: ${r.state_warning}`}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {masterProgressOpen && (
        <div className="modal modal-center" role="dialog" aria-modal="true" aria-labelledby="masterProgressTitle">
          <div className="modal-backdrop"></div>
          <div className="modal-content progress-modal">
            <div className="modal-header">
              <div id="masterProgressTitle" className="modal-title">Uploading Master Data</div>
            </div>
            <div className="modal-body">
              <div className="progress-label">{masterProgressLabel}</div>
              <div className="progress-track" aria-hidden="true">
                <div className="progress-fill" style={{ width: `${masterProgressPercent}%` }}></div>
              </div>
              <div className="progress-percent">{masterProgressPercent}%</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function sortRows(rows: Row[], key: string | null, dir: "asc" | "desc") {
  if (!key) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const an = Number(av);
    const bn = Number(bv);
    const bothNum = !Number.isNaN(an) && !Number.isNaN(bn);
    if (bothNum) return dir === "asc" ? an - bn : bn - an;
    const as = String(av).toLowerCase();
    const bs = String(bv).toLowerCase();
    if (as === bs) return 0;
    return dir === "asc" ? (as < bs ? -1 : 1) : (as > bs ? -1 : 1);
  });
  return sorted;
}

function groupByVariationSku(rows: Row[]) {
  const map = new Map<string, Row[]>();
  const list: Row[] = [];
  for (const row of rows) {
    const key = row[VARIATION_COLUMN];
    if (key === undefined || key === null) continue;
    if (!map.has(key)) {
      map.set(key, [row]);
      list.push(row);
    } else {
      map.get(key)!.push(row);
    }
  }
  for (const [key, group] of map.entries()) {
    group.sort((a, b) => {
      const as = String(a.ITEM_SKU ?? "").toLowerCase();
      const bs = String(b.ITEM_SKU ?? "").toLowerCase();
      if (as === bs) return 0;
      return as < bs ? -1 : 1;
    });
    const idx = list.findIndex((r) => r[VARIATION_COLUMN] === key);
    if (idx >= 0) list[idx] = group[0];
  }
  return { map, list };
}
