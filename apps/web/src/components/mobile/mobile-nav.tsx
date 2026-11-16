'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navItemsFor } from '@/components/layout/nav-items';
import { useTenant } from '@/components/layout/tenant-context';
import { cn } from '@/lib/utils';

/** Bottom tab bar for phones (the header navigation is hidden below `md`). */
export function MobileNav() {
  const pathname = usePathname();
  const items = navItemsFor(useTenant().role);
  return (
    <nav
      aria-label="Navegación móvil"
      className="fixed inset-x-0 bottom-0 z-40 grid border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex flex-col items-center gap-0.5 py-2 text-xs font-medium',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
