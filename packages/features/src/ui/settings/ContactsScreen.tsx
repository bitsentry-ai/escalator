import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfiguredContact,
  ChannelSecretOptions,
  ConfigurationPageInput,
} from "../../contracts/index.js";
import type { ContactSettingsClient } from "../settings-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { ContactEditor } from "./ContactEditor.js";
import { CredentialForm } from "./CredentialForm.js";
export function ContactsScreen({
  client,
  canManage,
  t,
}: {
  client: ContactSettingsClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const [available, setAvailable] = useState(false);
  const [created, setCreated] = useState<ChannelSecretOptions["items"]>([]);
  const [selected, setSelected] = useState<ConfiguredContact | null>();
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setAvailable(false);
    setCreated([]);
    setSelected(undefined);
    return () => {
      generation.current++;
    };
  }, [client, canManage]);
  const listSecrets = useCallback(
    async (input: ConfigurationPageInput) => {
      if (!canManage) return { items: [], next: null };
      const current = generation.current;
      try {
        const page = await client.secretOptions(input);
        if (current === generation.current) setAvailable(page.available);
        return page;
      } catch (error) {
        if (current === generation.current) setAvailable(false);
        throw error;
      }
    },
    [client, canManage],
  );
  const contacts = useCollection(client.contacts);
  const responders = useCollection(client.responders);
  const secrets = useCollection(listSecrets);
  const loading = contacts.loading || responders.loading || secrets.loading;
  const error = contacts.error || responders.error || secrets.error;
  const options = [
    ...created,
    ...secrets.items.filter(
      (item) => !created.some((value) => value.id === item.id),
    ),
  ];
  return (
    <section aria-label={t("settings.contacts")}>
      <h1>{t("settings.contacts")}</h1>
      <p>{t("settings.contactsHelp")}</p>
      {loading && <p role="status">{t("settings.loading")}</p>}
      {error && <p role="alert">{t("settings.loadError")}</p>}
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => {
          contacts.refresh();
          responders.refresh();
          secrets.refresh();
        }}
      >
        {t("settings.refresh")}
      </button>
      {canManage && (
        <button
          style={styles.button}
          disabled={
            !available ||
            selected === null ||
            !responders.items.some((person) => person.enabled)
          }
          onClick={() => setSelected(null)}
        >
          {t("settings.newContact")}
        </button>
      )}
      {canManage && !secrets.loading && !secrets.error && !available && (
        <p>{t("settings.credentialsUnavailable")}</p>
      )}
      {!contacts.loading && !contacts.error && !contacts.items.length && (
        <p>{t("settings.noContacts")}</p>
      )}
      <ul>
        {contacts.items.map((contact) => (
          <li key={contact.id}>
            <span>
              {responders.items.find(
                (person) => person.id === contact.responderId,
              )?.displayName ?? contact.responderId}{" "}
              · {contact.channel} · {contact.priority} ·{" "}
              {contact.enabled ? t("settings.enabled") : t("settings.disabled")}
            </span>
            {canManage && (
              <button
                style={styles.button}
                disabled={!available}
                aria-pressed={selected?.id === contact.id}
                onClick={() => setSelected(contact)}
              >
                {t("settings.edit")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {contacts.next && (
        <button
          style={styles.button}
          disabled={contacts.loading}
          onClick={() => void contacts.more()}
        >
          {t("settings.moreContacts")}
        </button>
      )}
      {responders.next && (
        <button
          style={styles.button}
          disabled={responders.loading}
          onClick={() => void responders.more()}
        >
          {t("settings.moreResponders")}
        </button>
      )}
      {canManage && secrets.next && (
        <button
          style={styles.button}
          disabled={secrets.loading}
          onClick={() => void secrets.more()}
        >
          {t("settings.moreCredentials")}
        </button>
      )}
      {canManage && available && selected !== undefined && (
        <ContactEditor
          key={selected ? `${selected.id}:${selected.version}` : "new"}
          initial={selected ?? undefined}
          responders={responders.items}
          secrets={options}
          client={client}
          t={t}
          onCancel={() => setSelected(undefined)}
          onSaved={() => {
            setSelected(undefined);
            contacts.refresh();
          }}
        />
      )}
      {canManage && available && (
        <CredentialForm
          client={client}
          t={t}
          onCreated={(value) => {
            setCreated((previous) =>
              [value, ...previous.filter((item) => item.id !== value.id)].slice(
                0,
                50,
              ),
            );
            secrets.refresh();
          }}
        />
      )}
    </section>
  );
}
