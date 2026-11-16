'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { AccountMenu } from './account-menu';
import { Logo } from './logo';
import { navItemsFor } from './nav-items';
import { useTenant } from './tenant-context';

export function AppHeader({
  clinicName,
  user,
  platformAdmin = false,
}: {
  clinicName: string;
  user: { name: string | null; email: string | null; picture: string | null };
  /** F31: show the link to the platform console. */
  platformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const { role } = useTenant();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Logo href="/dashboard" />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Principal">
          {navItemsFor(role)
            .filter((i) => i.href !== '/dashboard')
            .map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden max-w-48 truncate text-sm text-muted-foreground lg:inline">{clinicName}</span>
          <AccountMenu clinicName={clinicName} user={user} platformAdmin={platformAdmin} />
        </div>
      </div>
    </header>
  );
}
