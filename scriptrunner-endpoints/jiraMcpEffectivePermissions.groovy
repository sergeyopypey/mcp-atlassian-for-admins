/**
 * ScriptRunner REST Endpoint: Effective Permissions
 *
 * Resolves actual effective permissions for a user on a project by walking
 * groups, project roles, and permission grants. Answers "who can actually do X".
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpEffectivePermissions
 * Query params:
 *   projectKey (required) - project to check
 *   username   (optional) - specific user to check (returns all granted permissions for that user)
 *   permission (optional) - specific permission key to check (returns all users/groups that have it)
 *
 * At least one of username or permission must be provided.
 *
 * Response varies by query — see examples in output.
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.project.Project
import com.atlassian.jira.project.ProjectManager
import com.atlassian.jira.security.PermissionManager
import com.atlassian.jira.security.plugin.ProjectPermissionKey
import com.atlassian.jira.user.ApplicationUser
import com.atlassian.jira.user.util.UserManager

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

jiraMcpEffectivePermissions(httpMethod: "GET") { MultivaluedMap queryParams ->
    PermissionManager permissionManager = ComponentAccessor.getComponent(PermissionManager)
    ProjectManager projectManager = ComponentAccessor.projectManager
    UserManager userManager = ComponentAccessor.userManager

    String projectKey = queryParams.getFirst("projectKey") as String
    String username = queryParams.getFirst("username") as String
    String permissionKeyParam = queryParams.getFirst("permission") as String

    if (!projectKey) {
        return Response.status(400)
            .entity(new JsonBuilder([error: "projectKey parameter is required"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    if (!username && !permissionKeyParam) {
        return Response.status(400)
            .entity(new JsonBuilder([error: "At least one of 'username' or 'permission' is required"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    Project project = projectManager.getProjectByCurrentKey(projectKey)
    if (!project) {
        return Response.status(404)
            .entity(new JsonBuilder([error: "Project not found: ${projectKey}"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    // Known project permission keys
    List<String> allPermissions = [
        "BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "ASSIGN_ISSUES",
        "RESOLVE_ISSUES", "CLOSE_ISSUES", "MODIFY_REPORTER", "DELETE_ISSUES",
        "LINK_ISSUES", "SET_ISSUE_SECURITY", "SCHEDULE_ISSUES",
        "MOVE_ISSUES", "ASSIGNABLE_USER", "MANAGE_WATCHERS",
        "ADD_COMMENTS", "EDIT_ALL_COMMENTS", "EDIT_OWN_COMMENTS",
        "DELETE_ALL_COMMENTS", "DELETE_OWN_COMMENTS",
        "CREATE_ATTACHMENTS", "DELETE_ALL_ATTACHMENTS", "DELETE_OWN_ATTACHMENTS",
        "WORK_ON_ISSUES", "EDIT_OWN_WORKLOGS", "EDIT_ALL_WORKLOGS",
        "DELETE_OWN_WORKLOGS", "DELETE_ALL_WORKLOGS",
        "ADMINISTER_PROJECTS", "TRANSITION_ISSUES",
        "VIEW_WORKFLOW_READONLY", "VIEW_VOTERS_AND_WATCHERS",
        "MANAGE_SPRINTS_PERMISSION"
    ]

    Map<String, Object> result = [project: projectKey] as Map<String, Object>

    if (username) {
        ApplicationUser user = userManager.getUserByName(username)
        if (!user) {
            return Response.status(404)
                .entity(new JsonBuilder([error: "User not found: ${username}"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }

        List<String> granted = []
        List<String> denied = []

        allPermissions.each { String perm ->
            try {
                ProjectPermissionKey permKey = new ProjectPermissionKey(perm)
                if (permissionManager.hasPermission(permKey, project, user)) {
                    granted.add(perm)
                } else {
                    denied.add(perm)
                }
            } catch (Exception ignored) {
                // Permission key may not exist in this version
            }
        }

        result.user = username
        result.userDisplayName = user.displayName
        result.grantedPermissions = granted
        result.deniedPermissions = denied
    }

    if (permissionKeyParam) {
        try {
            ProjectPermissionKey permKey = new ProjectPermissionKey(permissionKeyParam)
            Collection<ApplicationUser> usersWithPerm = permissionManager.getAllUsers(permKey, project)

            List<Map<String, Object>> userList = usersWithPerm.collect { ApplicationUser u ->
                [
                    username    : u.username,
                    displayName : u.displayName,
                    emailAddress: u.emailAddress,
                    active      : u.isActive()
                ] as Map<String, Object>
            }

            result.permission = permissionKeyParam
            result.usersWithPermission = userList
            result.userCount = usersWithPerm.size()
        } catch (Exception e) {
            result.error = "Failed to resolve permission '${permissionKeyParam}': ${e.message}"
        }
    }

    Response.ok(new JsonBuilder(result).toString())
        .header("Content-Type", "application/json")
        .build()
}
