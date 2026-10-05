"use client";

import type { ReactNode } from "react";

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  unit,
  placeholder = "0.00",
}: {
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
}) {
  return (
    <span className="input">
      <input
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(",", ".");
          if (v === "" || /^\d*\.?\d*$/.test(v)) onChange(v);
        }}
      />
      {unit && <em>{unit}</em>}
    </span>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly (readonly [T, string, string?])[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map(([v, label, cls]) => (
        <button key={v} type="button" role="tab" aria-selected={v === value} className={`${v === value ? "on" : ""} ${cls ?? ""}`} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function NotLive() {
  return (
    <div className="card">
      <Empty title="Contracts are not deployed on this network yet.">This page fills in as soon as the xStockFi contracts are live.</Empty>
    </div>
  );
}
