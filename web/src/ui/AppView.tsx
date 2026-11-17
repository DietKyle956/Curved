import { WarningCircle } from "@phosphor-icons/react";

import type { Workspace } from "../application/workspace.ts";
import { boardPath, queuePath } from "../domain/routes.ts";
import { Board } from "./Board.tsx";
import { BootError, BootScreen } from "./Boot.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { IssueDetail } from "./IssueDetail.tsx";
import { NewIssueDialog } from "./NewIssueDialog.tsx";
import { ProjectSetup } from "./ProjectSetup.tsx";
import { Queue } from "./Queue.tsx";
import { MobileNav, Sidebar, Topbar } from "./Shell.tsx";
import { SignIn } from "./SignIn.tsx";
import { Toasts } from "./Toasts.tsx";
import { Button } from "./ui.tsx";

export function AppView({ workspace }: { workspace: Workspace }) {
  if (workspace.auth === "checking") {
    return <BootScreen />;
  }

  if (workspace.auth === "error") {
    return (
      <BootError
        message={workspace.bootError ?? "The server did not respond."}
        onRetry={workspace.retrySession}
      />
    );
  }

  if (workspace.auth === "anonymous") {
    return <SignIn onSignIn={workspace.signIn} />;
  }

  if (!workspace.projectsLoaded) {
    return <BootScreen label="Loading projects" />;
  }

  if (workspace.projectsError !== null && workspace.projects.length === 0) {
    return (
      <BootError
        message={workspace.projectsError}
        onRetry={workspace.retryProjects}
      />
    );
  }

  if (workspace.projects.length === 0) {
    return (
      <ProjectSetup
        onCreate={workspace.createProject}
        onCreated={workspace.projectCreated}
        onSignOut={workspace.signOut}
      />
    );
  }

  const project = workspace.project;

  if (project === null) {
    return <BootScreen />;
  }

  return (
    <>
      <div className="fixed inset-0 flex h-[100dvh] overflow-hidden">
        <Sidebar
          projects={workspace.projects}
          project={project}
          route={workspace.route}
          issues={workspace.issues}
          readyCount={workspace.ready?.ready.length ?? 0}
          labelFilter={workspace.labelFilter}
          onLabelFilter={workspace.setLabelFilter}
          onProjectChange={workspace.selectProject}
          onNavigate={workspace.navigate}
          onSignOut={workspace.signOut}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            projects={workspace.projects}
            project={project}
            route={workspace.route}
            query={workspace.query}
            onQueryChange={workspace.setQuery}
            onProjectChange={workspace.selectProject}
            onNewIssue={() => {
              workspace.openNewIssue("backlog");
            }}
            onRefresh={workspace.refresh}
            refreshing={workspace.refreshing}
          />

          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <main className="flex min-w-0 flex-1 flex-col">
              {workspace.issuesError !== null && workspace.issues.length > 0 ? (
                <div className="flex items-center gap-2 border-b border-storm/25 bg-storm/[0.07] px-4 py-1.5 text-[10.5px] text-storm">
                  <WarningCircle className="size-3.5 shrink-0" aria-hidden="true" />
                  Refresh failed: {workspace.issuesError}
                </div>
              ) : null}

              {workspace.issuesError !== null && workspace.issues.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-5">
                  <div className="w-full max-w-sm rounded-ui border border-line bg-panel p-4">
                    <WarningCircle className="size-4 text-storm" aria-hidden="true" />
                    <p className="mt-2 text-[12.5px] leading-relaxed text-fg-secondary">
                      {workspace.issuesError}
                    </p>
                    <Button
                      variant="secondary"
                      size="md"
                      className="mt-3"
                      onClick={workspace.refresh}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : workspace.route.kind === "queue" ? (
                <Queue
                  issues={workspace.issues}
                  ready={workspace.ready}
                  loading={workspace.issuesLoading}
                  onOpenIssue={workspace.openIssue}
                  onUnblock={async (key) => {
                    await workspace.unblock(key);
                  }}
                  onNewIssue={() => {
                    workspace.openNewIssue("todo");
                  }}
                />
              ) : (
                <Board
                  key={project.key}
                  issues={workspace.issues}
                  query={workspace.query}
                  labelFilter={workspace.labelFilter}
                  readyCount={workspace.ready?.ready.length ?? 0}
                  loading={workspace.issuesLoading}
                  onOpenIssue={workspace.openIssue}
                  onMove={(key, status) => {
                    void workspace.move(key, status);
                  }}
                  onNewIssue={workspace.openNewIssue}
                  onClearFilters={() => {
                    workspace.setQuery("");
                    workspace.setLabelFilter(null);
                  }}
                  onOpenQueue={() => {
                    workspace.navigate(queuePath(project.key));
                  }}
                />
              )}
            </main>

            {workspace.issueKey !== null ? (
              <IssueDetail
                issueKey={workspace.issueKey}
                timeline={workspace.timeline}
                loading={workspace.detailLoading}
                error={workspace.detailError}
                allLabels={workspace.allLabels}
                issueKeys={workspace.issueKeys}
                onClose={() => {
                  workspace.navigate(boardPath(project.key));
                }}
                onOpenIssueKey={workspace.openIssueKey}
                onRetry={workspace.retryDetail}
                onTransition={workspace.move}
                onComment={workspace.comment}
                onUpdate={workspace.updateIssue}
                onSetLabels={workspace.setLabels}
                onAddRelation={workspace.addRelation}
                onUnblock={workspace.unblock}
              />
            ) : null}
          </div>

          <MobileNav
            route={workspace.route}
            readyCount={workspace.ready?.ready.length ?? 0}
            onNavigate={workspace.navigate}
            onNewIssue={() => {
              workspace.openNewIssue("backlog");
            }}
            onOpenPalette={workspace.openPalette}
            projectKey={project.key}
          />
        </div>
      </div>

      <CommandPalette
        open={workspace.paletteOpen}
        onClose={workspace.closePalette}
        issues={workspace.issues}
        projects={workspace.projects}
        project={project}
        onOpenIssue={workspace.openIssue}
        onNavigate={workspace.navigate}
        onNewIssue={() => {
          workspace.openNewIssue("backlog");
        }}
        onSignOut={workspace.signOut}
        onRefresh={workspace.refresh}
      />

      <NewIssueDialog
        open={workspace.route.kind === "new"}
        project={project}
        defaultStatus={workspace.newIssueStatus}
        allLabels={workspace.allLabels}
        onClose={workspace.closeNewIssue}
        onCreate={workspace.createIssue}
      />

      <Toasts items={workspace.toasts} onDismiss={workspace.dismissToast} />
    </>
  );
}
