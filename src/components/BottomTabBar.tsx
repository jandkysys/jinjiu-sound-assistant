import { useLocation } from "wouter";
import { useIsMobile } from "../hooks/use-mobile";

const TABS = [
  { path: "/manage",   label: "管理", icon: "📂" },
  { path: "/settings", label: "设置", icon: "⚙️" },
] as const;

export default function BottomTabBar() {
  const isMobile = useIsMobile();
  const [location, navigate] = useLocation();

  if (!isMobile) return null;

  const isMainPage =
    location === "/" ||
    location === "" ||
    location === import.meta.env.BASE_URL ||
    location === import.meta.env.BASE_URL?.replace(/\/$/, "");

  if (isMainPage) return null;

  return (
    <nav className="bottom-tab-bar" role="tablist">
      {TABS.map(tab => {
        const active = location.startsWith(tab.path);
        return (
          <button
            key={tab.path}
            role="tab"
            aria-selected={active}
            className={`tab-btn${active ? " active" : ""}`}
            onClick={() => navigate(tab.path)}
          >
            <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
