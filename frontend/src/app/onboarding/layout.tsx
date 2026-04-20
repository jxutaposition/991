/**
 * Fills the main column (with root `main` as flex) so the wizard can use the full height beside Nav.
 */
export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col min-h-0 min-w-0 w-full">{children}</div>;
}
