import Link from 'next/link';
import { cn } from '@/lib/utils';

export function Logo({ href = '/', className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn('flex items-center gap-2 font-bold tracking-tight', className)}>
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-primary text-sm text-primary-foreground">
        C
      </span>
      <span className="text-lg">
        Clinic<span className="text-primary">AI</span>
      </span>
    </Link>
  );
}
