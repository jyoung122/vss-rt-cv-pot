"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { BookOpen, LayoutDashboard, LogOut, Settings, ShieldAlert, Upload, Users, Video, Wand2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/live", label: "Live Ops", icon: Video },
  { href: "/uploads", label: "Uploads", icon: Upload },
  { href: "/incidents", label: "Incidents", icon: ShieldAlert },
  { href: "/rules", label: "Detection Rules", icon: Wand2 },
]

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/"
  return pathname.startsWith(href)
}

export function AppSidebar() {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <Sidebar collapsible="icon" data-tour="sidebar">
      <SidebarHeader>
        <Link href="/" className="flex items-center justify-center px-2 py-3">
          <img
            src="/brand/favicon.png"
            alt="AIMS"
            className="size-6 hidden group-data-[collapsible=icon]:block"
          />
          <img
            src="/brand/aims-logo.png"
            alt="AIMS"
            className="h-8 w-auto group-data-[collapsible=icon]:hidden"
          />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent data-tour="sidebar-nav">
            <SidebarMenu className="gap-2">
              {navItems.map((item) => {
                const tourAttr =
                  item.href === '/uploads' ? 'nav-uploads'
                  : item.href === '/incidents' ? 'nav-incidents'
                  : undefined
                return (
                  <SidebarMenuItem key={item.href} {...(tourAttr ? { 'data-tour': tourAttr } : {})}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(pathname, item.href)}
                      tooltip={item.label}
                      className="group-data-[collapsible=icon]:justify-center !bg-[var(--sidebar)] hover:!bg-[var(--accent-500)]/30 hover:!text-[var(--accent-500)] data-[active=true]:!bg-[var(--accent-500)] data-[active=true]:!text-white"
                    >
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Admin</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(pathname, "/settings")}
                  tooltip="Settings"
                  className="group-data-[collapsible=icon]:justify-center !bg-transparent hover:!bg-transparent hover:!text-[var(--accent-500)] data-[active=true]:!bg-transparent data-[active=true]:!text-[var(--accent-500)]"
                >
                  <Link href="/settings">
                    <Settings />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(pathname, "/team")}
                  tooltip="Team"
                  className="group-data-[collapsible=icon]:justify-center !bg-transparent hover:!bg-transparent hover:!text-[var(--accent-500)] data-[active=true]:!bg-transparent data-[active=true]:!text-[var(--accent-500)]"
                >
                  <Link href="/team">
                    <Users />
                    <span>Team</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Sign out"
                  className="group-data-[collapsible=icon]:justify-center !bg-transparent hover:!bg-transparent hover:!text-[var(--err-500)]"
                  onClick={async () => {
                    const supabase = createClient()
                    await supabase.auth.signOut()
                    router.push("/login")
                  }}
                >
                  <LogOut />
                  <span>Sign out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Knowledge"
                  className="group-data-[collapsible=icon]:justify-center !bg-transparent hover:!bg-transparent hover:!text-[var(--accent-500)]"
                >
                  <a href="/docs" target="_blank" rel="noopener noreferrer">
                    <BookOpen />
                    <span>Knowledge</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <div className="mx-2 mb-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Cameras online</span>
            <span className="font-mono text-[var(--ok-500)]">142 / 148</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
            <div className="h-full bg-[var(--ok-500)]" style={{ width: `${(142 / 148) * 100}%` }} />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>

  )
}
