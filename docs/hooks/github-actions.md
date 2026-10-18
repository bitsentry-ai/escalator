# GitHub Actions

Use the helper in the same job as the actual deployment. Keep an attempt-specific state directory on that runner. Build and publish the immutable release first, then run coverage immediately before the deployment command. Do not place the preflight in a much earlier build job.

This is a step excerpt to adapt to an existing deployment workflow, not a workflow installed by this change. `deploy-and-wait-for-result` denotes your existing synchronous deployment step: it must return success only after the exact release is deployed. Replace it with the real command for your platform; a webhook-accepted response is insufficient. For Kamal, use the native hooks instead of wrapping the same deployment twice. For asynchronous platforms, use the provider recipe's completion verification.

```yaml
# In an existing job with checkout, build and publication already complete:
env:
  ESCALATOR_URL: ${{ vars.ESCALATOR_URL }}
  ESCALATOR_TOKEN: ${{ secrets.ESCALATOR_DEPLOYMENT_TOKEN }}
  ESCALATOR_ENVIRONMENT: ${{ vars.ESCALATOR_ENVIRONMENT_ID }}
  ESCALATOR_SOURCE: github-actions
  ESCALATOR_RUN_ID: ${{ github.repository }}:${{ github.run_id }}:${{ github.run_attempt }}
  ESCALATOR_ACTOR: ${{ github.actor }}
  ESCALATOR_COMMIT: ${{ github.sha }}
  ESCALATOR_STATE: ${{ runner.temp }}/escalator-${{ github.run_id }}-${{ github.run_attempt }}/session.json
steps:
  - name: Check coverage and record deployment start
    id: escalator_start
    run: node ./ops/escalator/hook.mjs begin
  - name: Deploy and wait for the exact release
    id: release
    run: deploy-and-wait-for-result
  - name: Record confirmed completion
    if: ${{ success() && steps.release.outcome == 'success' }}
    run: node ./ops/escalator/hook.mjs finish SUCCEEDED
```

The normal step failure behavior prevents the deployment command after rejected coverage. Do not add `continue-on-error` to the gate. Keep values in environment variables rather than interpolating actor, branch or release names into shell code. Restrict the job and its secret to trusted deployment events; this recipe does not grant pull-request code access to production credentials.

A cancelled or lost runner cannot reliably report a terminal event. Its missing finish remains visible to timeout paging. Do not put `finish SUCCEEDED` in `always()`. A provider's confirmed failure may be reported explicitly as `FAILED`, but a failed HTTP call, runner cancellation or unconfirmed queue request is not evidence of the provider's terminal state. Preserve/recover state in a restricted deployment record when reconciliation is needed; never attach it to a public artifact.

## Manual check, not runtime-verified

Run the common cases in a disposable workflow separately authorized by its owner. Verify a blocked gate prevents the release step, a successful synchronous deployment records one finish, and cancelling the runner after start causes timeout paging. Re-run the workflow as a new attempt only after reconciling any prior ambiguous deployment; transport retries within the same attempt must retain the same state and body. No workflow was dispatched to verify this recipe.
