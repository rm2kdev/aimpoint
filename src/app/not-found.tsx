import { NotFoundMessage } from "@/components/not-found-message";

export const metadata = { title: "Page not found" };

/**
 * App-wide 404. Without it, a notFound() thrown below a layout made the server shell error, so React
 * client-rendered the whole document (and warned about next-themes' inline theme script) (VEC-138).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-full items-start justify-center pt-[env(safe-area-inset-top)]">
      <NotFoundMessage href="/" label="Go to Vector" />
    </main>
  );
}
