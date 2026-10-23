## ABSOLUTE WORKSPACE REQUIREMENT — IMPORTANT

The project workspace is exactly:

`/workspaces/codespaces-blank`

All CashBI project files, source code, tests, documentation, configuration files, and project-specific scripts must be created and maintained inside this directory.

Mandatory rules:

1. Before doing anything, verify that `/workspaces/codespaces-blank` exists and inspect its contents.
2. Set `/workspaces/codespaces-blank` as the working directory for all project-related commands.
3. Create the CashBI project directly inside `/workspaces/codespaces-blank`, not inside an additional nested directory such as `/workspaces/codespaces-blank/cashbi`.
4. Do not switch to another repository or create the project in the home directory, `/tmp`, or any other location.
5. Preserve all existing files in the workspace. Inspect them before making changes, and never delete or overwrite unrelated user files.
6. Do not assume the workspace is empty. Determine whether it already contains a Git repository or existing application and integrate with it safely.
7. Do not run destructive cleanup commands or reset the Git repository.
8. If the directory does not exist or cannot be accessed, stop filesystem modifications and report the exact problem rather than silently using another location.
9. Before finishing, verify that the generated project files are located inside `/workspaces/codespaces-blank` and report the absolute workspace path.
10. Keep generated build artifacts, tests, and documentation inside the project workspace unless an external location is strictly required by the development tool.

Start by running `pwd` and inspecting `/workspaces/codespaces-blank`. All subsequent project implementation and testing must use this workspace.