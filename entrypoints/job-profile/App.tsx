import { useState, useEffect, useRef } from "react";
import { Authenticated, Unauthenticated, AuthLoading, useMutation, useQuery } from "convex/react";
import { AppProviders } from "../../src/components/AppProviders";
import { AuthScreen } from "../../src/components/AuthScreen";
import { TokenBridge } from "../../src/components/TokenBridge";
import { api } from "../../convex/_generated/api";
import * as pdfjs from "pdfjs-dist";

// Point pdf.js worker at the bundled worker file via Vite's ?url import
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ── Types ──────────────────────────────────────────────────────────────────

export interface JobProfile {
  personal: {
    firstName: string;
    lastName: string;
    preferredName: string;
    pronouns: string;
    email: string;
    phone: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  links: {
    linkedin: string;
    github: string;
    portfolio: string;
    website: string;
  };
  workAuth: {
    country: string;
    employmentType: string;
    workModality: string;
    requireVisaNow: boolean;
    futureVisaSupport: boolean;
    willingToRelocate: boolean;
    willingToTravel: boolean;
    startDate: string;
    salary: string;
    clearance: string;
  };
  eeo: {
    source: string;
    gender: string;
    veteranStatus: string;
    disabilityStatus: string;
  };
  demographics: {
    ageRange: string;
    race: string;
    ethnicity: string;
    militaryStatus: string;
  };
  consents: {
    privacyPolicy: boolean;
    backgroundCheck: boolean;
    informationAccuracy: boolean;
  };
  resume: {
    fileName: string;
    text: string;
    // base64 + mimeType live only in chrome.storage.local, not in Convex
    base64?: string;
    mimeType?: string;
  };
}

const DEFAULT_PROFILE: JobProfile = {
  personal: {
    firstName: "", lastName: "", preferredName: "", pronouns: "",
    email: "", phone: "", city: "", state: "", postalCode: "", country: "United States",
  },
  links: { linkedin: "", github: "", portfolio: "", website: "" },
  workAuth: {
    country: "United States", employmentType: "Full-time", workModality: "Flexible",
    requireVisaNow: false, futureVisaSupport: false, willingToRelocate: false,
    willingToTravel: false, startDate: "", salary: "", clearance: "",
  },
  eeo: { source: "", gender: "", veteranStatus: "", disabilityStatus: "" },
  demographics: { ageRange: "", race: "", ethnicity: "", militaryStatus: "" },
  consents: { privacyPolicy: false, backgroundCheck: false, informationAccuracy: false },
  resume: { fileName: "", text: "" },
};

// ── Small helpers ──────────────────────────────────────────────────────────

function Field({
  label, required, children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="jp-field">
      <label>
        {label}
        {required && <span className="required"> *</span>}
      </label>
      {children}
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, type = "text",
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function SelectInput({
  value, onChange, options, placeholder,
}: { value: string; onChange: (v: string) => void; options: string[]; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="jp-checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ── Resume Upload ──────────────────────────────────────────────────────────

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve) => {
    const blob = new Blob([buffer]);
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // strip the "data:...;base64," prefix
      resolve(dataUrl.split(",")[1] ?? "");
    };
    reader.readAsDataURL(blob);
  });
}

async function extractResumeData(file: File): Promise<{ text: string; base64: string; mimeType: string }> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const buffer = await file.arrayBuffer();
  const base64 = await arrayBufferToBase64(buffer);
  const mimeType = file.type || (isPdf ? "application/pdf" : "text/plain");

  if (isPdf) {
    const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(pageText);
    }
    return { text: pages.join("\n").slice(0, 30000), base64, mimeType };
  }

  const text = await file.text();
  return { text: text.slice(0, 30000), base64, mimeType };
}

function ResumeUpload({
  fileName, onUpload, onClear,
}: {
  fileName: string;
  onUpload: (name: string, text: string, base64: string, mimeType: string) => void;
  onClear: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setParsing(true);
    setParseError(null);
    try {
      const { text, base64, mimeType } = await extractResumeData(file);
      onUpload(file.name, text, base64, mimeType);
    } catch (err: any) {
      setParseError(`Could not parse file: ${err?.message ?? "unknown error"}`);
    } finally {
      setParsing(false);
    }
  }

  if (fileName) {
    return (
      <div className="jp-resume-file">
        <div className="jp-resume-file-name">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>{fileName}</span>
        </div>
        <button
          type="button"
          onClick={onClear}
          style={{ background: "none", border: "none", color: "#666", cursor: "pointer", padding: "4px 8px", fontSize: 13, borderRadius: 4 }}
        >
          ✕ Remove
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className="jp-resume-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        onClick={() => !parsing && fileRef.current?.click()}
        style={{ cursor: parsing ? "wait" : undefined, opacity: parsing ? 0.7 : 1 }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,.md,.doc,.docx"
          disabled={parsing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>{parsing ? "Parsing file…" : "Drop resume here, or click to browse"}</span>
        <span style={{ fontSize: 11, color: "#aaa", fontWeight: 400 }}>PDF, TXT, MD — max 30 KB text extracted</span>
      </div>
      {parseError && (
        <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{parseError}</div>
      )}
    </>
  );
}

// ── Main Form ──────────────────────────────────────────────────────────────

function JobProfilePage() {
  const profile = useQuery(api.users.getProfile);
  const updateProfile = useMutation(api.users.updateProfile);

  const [jp, setJp] = useState<JobProfile>(DEFAULT_PROFILE);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  // Load saved profile
  useEffect(() => {
    if (!profile?.jobProfile) return;
    try {
      const parsed = JSON.parse(profile.jobProfile) as JobProfile;
      setJp((prev) => ({
        personal: { ...prev.personal, ...parsed.personal },
        links: { ...prev.links, ...parsed.links },
        workAuth: { ...prev.workAuth, ...parsed.workAuth },
        eeo: { ...prev.eeo, ...parsed.eeo },
        demographics: { ...prev.demographics, ...parsed.demographics },
        consents: { ...prev.consents, ...parsed.consents },
        resume: { ...prev.resume, ...parsed.resume },
      }));
    } catch { /* ignore malformed */ }
  }, [profile?._id]);

  function setPersonal<K extends keyof JobProfile["personal"]>(k: K, v: JobProfile["personal"][K]) {
    setJp((p) => ({ ...p, personal: { ...p.personal, [k]: v } }));
  }
  function setLinks<K extends keyof JobProfile["links"]>(k: K, v: string) {
    setJp((p) => ({ ...p, links: { ...p.links, [k]: v } }));
  }
  function setWorkAuth<K extends keyof JobProfile["workAuth"]>(k: K, v: JobProfile["workAuth"][K]) {
    setJp((p) => ({ ...p, workAuth: { ...p.workAuth, [k]: v } }));
  }
  function setEeo<K extends keyof JobProfile["eeo"]>(k: K, v: string) {
    setJp((p) => ({ ...p, eeo: { ...p.eeo, [k]: v } }));
  }
  function setDemo<K extends keyof JobProfile["demographics"]>(k: K, v: string) {
    setJp((p) => ({ ...p, demographics: { ...p.demographics, [k]: v } }));
  }
  function setConsents<K extends keyof JobProfile["consents"]>(k: K, v: boolean) {
    setJp((p) => ({ ...p, consents: { ...p.consents, [k]: v } }));
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      // Save structured profile to Convex (text only — no base64 in DB)
      const profileForDb = {
        ...jp,
        resume: { fileName: jp.resume.fileName, text: jp.resume.text },
      };
      await updateProfile({ jobProfile: JSON.stringify(profileForDb) } as any);

      // Save the raw base64 file separately to chrome.storage.local
      // so the agent can attach it to <input type="file"> fields
      if (jp.resume.base64 && jp.resume.fileName) {
        await chrome.storage.local.set({
          resumeFile: {
            name: jp.resume.fileName,
            mimeType: jp.resume.mimeType,
            base64: jp.resume.base64,
          },
        });
      } else if (!jp.resume.fileName) {
        await chrome.storage.local.remove("resumeFile");
      }

      setStatus({ msg: "Profile saved", ok: true });
      setTimeout(() => setStatus(null), 3000);
    } catch (err: any) {
      setStatus({ msg: err.message ?? "Save failed", ok: false });
    } finally {
      setSaving(false);
    }
  }

  function goBack() {
    chrome.runtime.openOptionsPage();
  }

  const { personal, links, workAuth, eeo, demographics, consents, resume } = jp;

  return (
    <main className="jp-container">
      {/* Header */}
      <header className="jp-header">
        <img src={chrome.runtime.getURL("logo.png")} alt="CheatResume" className="jp-header-logo" />
        <div className="jp-header-text">
          <h1>Job Profile</h1>
          <p>CheatResume · Auto-fill for job applications</p>
        </div>
      </header>

      {/* Info banner */}
      <div className="jp-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: 1 }}>
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          This profile is passed as structured JSON to the AI agent when filling job applications —
          the more you fill in, the more accurately it can complete forms on your behalf.
        </span>
      </div>

      {/* ── Personal Information ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Personal Information</h2>
        <div className="jp-grid-2">
          <Field label="First Name" required>
            <TextInput value={personal.firstName} onChange={(v) => setPersonal("firstName", v)} placeholder="Sajan" />
          </Field>
          <Field label="Last Name" required>
            <TextInput value={personal.lastName} onChange={(v) => setPersonal("lastName", v)} placeholder="Poudel" />
          </Field>
        </div>
        <div className="jp-grid-2">
          <Field label="Preferred Name">
            <TextInput value={personal.preferredName} onChange={(v) => setPersonal("preferredName", v)} placeholder="Nickname" />
          </Field>
          <Field label="Pronouns">
            <SelectInput
              value={personal.pronouns}
              onChange={(v) => setPersonal("pronouns", v)}
              options={["He/Him", "She/Her", "They/Them", "He/They", "She/They", "Prefer not to say", "Other"]}
              placeholder="Select pronouns"
            />
          </Field>
        </div>
        <div className="jp-grid-2">
          <Field label="Email" required>
            <TextInput value={personal.email} onChange={(v) => setPersonal("email", v)} placeholder="you@email.com" type="email" />
          </Field>
          <Field label="Phone" required>
            <TextInput value={personal.phone} onChange={(v) => setPersonal("phone", v)} placeholder="1000000000" type="tel" />
          </Field>
        </div>
        <div className="jp-divider" />
        <div className="jp-grid-2">
          <Field label="City">
            <TextInput value={personal.city} onChange={(v) => setPersonal("city", v)} placeholder="" />
          </Field>
          <Field label="State / Province">
            <TextInput value={personal.state} onChange={(v) => setPersonal("state", v)} placeholder="KY" />
          </Field>
        </div>
        <div className="jp-grid-2">
          <Field label="Postal Code">
            <TextInput value={personal.postalCode} onChange={(v) => setPersonal("postalCode", v)} placeholder="12345" />
          </Field>
          <Field label="Country">
            <SelectInput
              value={personal.country}
              onChange={(v) => setPersonal("country", v)}
              options={["United States", "Canada", "United Kingdom", "Australia", "India", "Germany", "France", "Other"]}
            />
          </Field>
        </div>
      </section>

      {/* ── Professional Links ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Professional Links</h2>
        <Field label="LinkedIn URL">
          <TextInput value={links.linkedin} onChange={(v) => setLinks("linkedin", v)} placeholder="https://linkedin.com/in/yourname" />
        </Field>
        <Field label="GitHub URL">
          <TextInput value={links.github} onChange={(v) => setLinks("github", v)} placeholder="https://github.com/yourname" />
        </Field>
        <div className="jp-grid-2">
          <Field label="Portfolio URL">
            <TextInput value={links.portfolio} onChange={(v) => setLinks("portfolio", v)} placeholder="https://yourportfolio.com" />
          </Field>
          <Field label="Personal Website">
            <TextInput value={links.website} onChange={(v) => setLinks("website", v)} placeholder="https://yourwebsite.com" />
          </Field>
        </div>
      </section>

      {/* ── Resume ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Resume</h2>
        <p className="jp-card-hint">The AI agent will attach or paste your resume content when job applications require it.</p>
        <ResumeUpload
          fileName={resume.fileName}
          onUpload={(name, text, base64, mimeType) => setJp((p) => ({ ...p, resume: { fileName: name, text, base64, mimeType } }))}
          onClear={() => setJp((p) => ({ ...p, resume: { fileName: "", text: "", base64: "", mimeType: "" } }))}
        />
        {resume.text && (
          <div style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>
            {Math.round(resume.text.length / 1000)}KB parsed · {resume.text.split(/\s+/).length} words
          </div>
        )}
      </section>

      {/* ── Work Authorization & Preferences ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Work Authorization & Preferences</h2>
        <div className="jp-grid-2">
          <Field label="Work Authorization Country">
            <SelectInput
              value={workAuth.country}
              onChange={(v) => setWorkAuth("country", v)}
              options={["United States", "Canada", "United Kingdom", "Australia", "India", "Other"]}
            />
          </Field>
          <Field label="Employment Type">
            <SelectInput
              value={workAuth.employmentType}
              onChange={(v) => setWorkAuth("employmentType", v)}
              options={["Full-time", "Part-time", "Contract", "Internship", "Freelance", "Any"]}
            />
          </Field>
        </div>
        <Field label="Work Modality">
          <SelectInput
            value={workAuth.workModality}
            onChange={(v) => setWorkAuth("workModality", v)}
            options={["Remote", "Hybrid", "On-site", "Flexible"]}
          />
        </Field>
        <div className="jp-checkboxes">
          <Checkbox label="Require visa now" checked={workAuth.requireVisaNow} onChange={(v) => setWorkAuth("requireVisaNow", v)} />
          <Checkbox label="Future visa support needed" checked={workAuth.futureVisaSupport} onChange={(v) => setWorkAuth("futureVisaSupport", v)} />
          <Checkbox label="Willing to relocate" checked={workAuth.willingToRelocate} onChange={(v) => setWorkAuth("willingToRelocate", v)} />
          <Checkbox label="Willing to travel" checked={workAuth.willingToTravel} onChange={(v) => setWorkAuth("willingToTravel", v)} />
        </div>
        <div className="jp-grid-2">
          <Field label="Earliest Start Date">
            <TextInput value={workAuth.startDate} onChange={(v) => setWorkAuth("startDate", v)} placeholder="MM/DD/YYYY" />
          </Field>
          <Field label="Compensation Expectation">
            <TextInput value={workAuth.salary} onChange={(v) => setWorkAuth("salary", v)} placeholder="$80,000 - $120,000" />
          </Field>
        </div>
        <Field label="Security Clearance">
          <TextInput value={workAuth.clearance} onChange={(v) => setWorkAuth("clearance", v)} placeholder="e.g., Secret, Top Secret" />
        </Field>
      </section>

      {/* ── Application Source & EEO ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Application Source & EEO</h2>
        <p className="jp-card-hint">Used for Equal Employment Opportunity questions on job applications.</p>
        <div className="jp-grid-2">
          <Field label="How did you hear about us?">
            <SelectInput
              value={eeo.source}
              onChange={(v) => setEeo("source", v)}
              options={["Company Career Site", "LinkedIn", "Indeed", "Glassdoor", "Referral", "Job Fair", "Other"]}
              placeholder="Select source"
            />
          </Field>
          <Field label="Gender">
            <SelectInput
              value={eeo.gender}
              onChange={(v) => setEeo("gender", v)}
              options={["Male", "Female", "Non-binary", "Prefer not to say", "Other"]}
              placeholder="Select gender"
            />
          </Field>
        </div>
        <div className="jp-grid-2">
          <Field label="Veteran Status">
            <SelectInput
              value={eeo.veteranStatus}
              onChange={(v) => setEeo("veteranStatus", v)}
              options={["I am not a veteran", "I am a veteran", "I am a disabled veteran", "Prefer not to say"]}
              placeholder="Select status"
            />
          </Field>
          <Field label="Disability Status">
            <SelectInput
              value={eeo.disabilityStatus}
              onChange={(v) => setEeo("disabilityStatus", v)}
              options={["No, I don't have a disability", "Yes, I have a disability", "Prefer not to say"]}
              placeholder="Select status"
            />
          </Field>
        </div>
      </section>

      {/* ── Demographics (optional) ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">
          Demographics
          <span className="jp-optional">Optional</span>
        </h2>
        <p className="jp-card-hint">Voluntary — helps improve job matching accuracy on some platforms.</p>
        <div className="jp-grid-2">
          <Field label="Age Range">
            <SelectInput
              value={demographics.ageRange}
              onChange={(v) => setDemo("ageRange", v)}
              options={["Under 18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]}
              placeholder="Select age range"
            />
          </Field>
          <Field label="Race">
            <SelectInput
              value={demographics.race}
              onChange={(v) => setDemo("race", v)}
              options={[
                "White", "Black or African American", "Asian",
                "Hispanic or Latino", "Native American", "Pacific Islander",
                "Two or more races", "Prefer not to say",
              ]}
              placeholder="Select race"
            />
          </Field>
        </div>
        <div className="jp-grid-2">
          <Field label="Ethnicity">
            <SelectInput
              value={demographics.ethnicity}
              onChange={(v) => setDemo("ethnicity", v)}
              options={["Hispanic or Latino", "Not Hispanic or Latino", "Prefer not to say"]}
              placeholder="Select ethnicity"
            />
          </Field>
          <Field label="Military Status">
            <SelectInput
              value={demographics.militaryStatus}
              onChange={(v) => setDemo("militaryStatus", v)}
              options={["Not Military", "Active Duty", "Reserve", "Veteran", "Prefer not to say"]}
              placeholder="Select status"
            />
          </Field>
        </div>
      </section>

      {/* ── Consents & Acknowledgments ── */}
      <section className="jp-card">
        <h2 className="jp-card-title">Consents & Acknowledgments</h2>
        <p className="jp-card-hint">Pre-fill your typical consent choices — the agent will check these boxes on your behalf.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Checkbox label="Privacy policy consent" checked={consents.privacyPolicy} onChange={(v) => setConsents("privacyPolicy", v)} />
          <Checkbox label="Background check consent" checked={consents.backgroundCheck} onChange={(v) => setConsents("backgroundCheck", v)} />
          <Checkbox label="Information accuracy acknowledgment" checked={consents.informationAccuracy} onChange={(v) => setConsents("informationAccuracy", v)} />
        </div>
      </section>

      {/* ── Actions ── */}
      <div className="jp-actions">
        <button className="jp-btn-save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save Profile"}
        </button>
        <button className="jp-btn-back" onClick={goBack}>
          ← Back to Settings
        </button>
        {status && (
          <span className={status.ok ? "jp-status-ok" : "jp-status-err"}>
            {status.msg}
          </span>
        )}
      </div>
    </main>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────

export function App() {
  return (
    <AppProviders>
      <TokenBridge />
      <AuthLoading>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "#666", fontFamily: "system-ui", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
          Loading…
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ width: "100%", maxWidth: 380 }}>
            <AuthScreen />
          </div>
        </div>
      </Unauthenticated>
      <Authenticated>
        <JobProfilePage />
      </Authenticated>
    </AppProviders>
  );
}
