import MainNav from "@/components/MainNav";

export default function HomeLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <MainNav />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
