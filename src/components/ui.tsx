import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

const variants = {
  primary:
    'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-950/50 disabled:bg-slate-700 disabled:text-slate-400',
  secondary:
    'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50',
  danger: 'bg-rose-900/60 hover:bg-rose-800 text-rose-100 border border-rose-800 disabled:opacity-50',
  ghost: 'hover:bg-slate-800 text-slate-300 disabled:opacity-50',
} as const;

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function TextInput({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 ${className}`}
      {...props}
    />
  );
}

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/60 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <h2 className="text-sm font-semibold tracking-wide text-slate-300">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  color = 'slate',
}: {
  children: ReactNode;
  color?: 'slate' | 'rose' | 'violet' | 'emerald' | 'amber' | 'sky';
}) {
  const colors = {
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
    rose: 'bg-rose-950/60 text-rose-300 border-rose-900',
    violet: 'bg-violet-950/60 text-violet-300 border-violet-900',
    emerald: 'bg-emerald-950/60 text-emerald-300 border-emerald-900',
    amber: 'bg-amber-950/60 text-amber-300 border-amber-900',
    sky: 'bg-sky-950/60 text-sky-300 border-sky-900',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium ${colors[color]}`}
    >
      {children}
    </span>
  );
}
