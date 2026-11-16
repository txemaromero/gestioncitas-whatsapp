import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { CheckCircle2Icon, XCircleIcon } from 'lucide-react';
import { APPOINTMENT_STATUS_LABELS_ES, ATTENDANCE_LABELS_ES, type AppointmentStatusValue, type AttendanceValue } from '@clinicai/shared';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        outline: 'text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        pending: 'border-amber-200 bg-amber-100 text-amber-900',
        confirmed: 'border-emerald-200 bg-emerald-100 text-emerald-900',
        cancelled: 'border-red-200 bg-red-100 text-red-900',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Pendiente (amarillo) · Confirmada (verde) · Cancelada (rojo). */
export function StatusBadge({ status }: { status: AppointmentStatusValue }) {
  return <Badge variant={status}>{APPOINTMENT_STATUS_LABELS_ES[status]}</Badge>;
}

/** F15: Asistió (green, check) · No se presentó (red, cross): status colour always with icon + label. */
export function AttendanceBadge({ attendance }: { attendance: AttendanceValue }) {
  const Icon = attendance === 'attended' ? CheckCircle2Icon : XCircleIcon;
  return (
    <Badge variant={attendance === 'attended' ? 'confirmed' : 'cancelled'} className="gap-1">
      <Icon className="size-3" aria-hidden />
      {ATTENDANCE_LABELS_ES[attendance]}
    </Badge>
  );
}

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 className={cn('font-semibold leading-none', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto rounded-xl border">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function THead(props: React.ComponentProps<'thead'>) {
  return <thead className="bg-muted/60 [&_tr]:border-b" {...props} />;
}

export function TBody(props: React.ComponentProps<'tbody'>) {
  return <tbody className="[&_tr:last-child]:border-0" {...props} />;
}

export function TR({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('border-b transition-colors hover:bg-muted/40', className)} {...props} />;
}

export function TH({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('h-10 px-3 text-left align-middle font-medium text-muted-foreground', className)} {...props} />;
}

export function TD({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
