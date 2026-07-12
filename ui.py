"""Tkinter user interface. GIS processing is delegated to processing.py."""

from __future__ import annotations

import logging
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from config import FieldMapping, ProcessingConfig
from processing import run_processing


class ConnectorApp(ttk.Frame):
    def __init__(self, master: tk.Tk) -> None:
        super().__init__(master, padding=12)
        self.master = master
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.variables = self._make_variables()
        self._build()
        self.after(100, self._poll_events)

    def _make_variables(self) -> dict[str, tk.Variable]:
        return {
            "taz_path": tk.StringVar(),
            "here_links_path": tk.StringVar(),
            "gstdm_links_path": tk.StringVar(),
            "nodes_path": tk.StringVar(),
            "output_folder": tk.StringVar(),
            "taz_id": tk.StringVar(value="N"),
            "node_id": tk.StringVar(value="N"),
            "link_from_node": tk.StringVar(value="A"),
            "link_to_node": tk.StringVar(value="B"),
            "link_func_class": tk.StringVar(value="FUNC_CLASS"),
            "sector_count": tk.StringVar(value="10"),
            "target_count": tk.StringVar(value="4"),
            "minimum_count": tk.StringVar(value="2"),
            "minimum_angle": tk.StringVar(value="60"),
            "maximum_snap": tk.StringVar(value=""),
            "blocked_major_level": tk.StringVar(value="3"),
            "boundary_tolerance": tk.StringVar(value="200"),
            "progress": tk.DoubleVar(value=0),
            "status": tk.StringVar(value="Ready"),
        }

    def _build(self) -> None:
        self.master.title("TAZ Centroid Connector Generator")
        self.master.geometry("920x720")
        self.master.minsize(760, 620)
        self.grid(sticky="nsew")
        self.master.columnconfigure(0, weight=1)
        self.master.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)

        inputs = ttk.LabelFrame(self, text="Input and Output", padding=10)
        inputs.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        inputs.columnconfigure(1, weight=1)
        rows = [
            ("TAZ polygon layer", "taz_path", False),
            ("HERE Master LINKS layer (density)", "here_links_path", False),
            ("GSTDM LINKS layer (display)", "gstdm_links_path", False),
            ("GSTDM Master NODES layer", "nodes_path", False),
            ("Output folder", "output_folder", True),
        ]
        for row_number, (label, key, folder) in enumerate(rows):
            ttk.Label(inputs, text=label).grid(row=row_number, column=0, sticky="w", padx=(0, 8), pady=3)
            ttk.Entry(inputs, textvariable=self.variables[key]).grid(row=row_number, column=1, sticky="ew", pady=3)
            ttk.Button(
                inputs,
                text="Browse...",
                command=lambda k=key, f=folder: self._browse(k, f),
            ).grid(row=row_number, column=2, padx=(8, 0), pady=3)

        mapping = ttk.LabelFrame(self, text="Field Mapping", padding=10)
        mapping.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        mapping.columnconfigure(1, weight=1)
        mapping.columnconfigure(3, weight=1)
        ttk.Label(mapping, text="TAZ ID field").grid(row=0, column=0, sticky="w")
        ttk.Entry(mapping, textvariable=self.variables["taz_id"]).grid(row=0, column=1, sticky="ew", padx=(8, 20))
        ttk.Label(mapping, text="Node ID field").grid(row=0, column=2, sticky="w")
        ttk.Entry(mapping, textvariable=self.variables["node_id"]).grid(row=0, column=3, sticky="ew", padx=(8, 0))
        ttk.Label(mapping, text="GSTDM link A field").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(mapping, textvariable=self.variables["link_from_node"]).grid(row=1, column=1, sticky="ew", padx=(8, 20), pady=(6, 0))
        ttk.Label(mapping, text="GSTDM link B field").grid(row=1, column=2, sticky="w", pady=(6, 0))
        ttk.Entry(mapping, textvariable=self.variables["link_to_node"]).grid(row=1, column=3, sticky="ew", padx=(8, 0), pady=(6, 0))
        ttk.Label(mapping, text="GSTDM link FUNC_CLASS field").grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(mapping, textvariable=self.variables["link_func_class"]).grid(row=2, column=1, sticky="ew", padx=(8, 20), pady=(6, 0))
        parameters = ttk.LabelFrame(self, text="Parameters (feet / degrees)", padding=10)
        parameters.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        parameter_rows = [
            ("Angular sectors per TAZ", "sector_count"),
            ("Maximum connectors (2-5)", "target_count"),
            ("Minimum connectors (2-5)", "minimum_count"),
            ("Minimum angle", "minimum_angle"),
            ("Maximum snap distance (blank = unlimited)", "maximum_snap"),
            ("Blocked node MAJOR_LEVEL (<=)", "blocked_major_level"),
            ("Snap node boundary tolerance", "boundary_tolerance"),
        ]
        for index, (label, key) in enumerate(parameter_rows):
            row, pair = divmod(index, 2)
            column = pair * 2
            ttk.Label(parameters, text=label).grid(row=row, column=column, sticky="w", padx=(0, 8), pady=3)
            ttk.Entry(parameters, textvariable=self.variables[key], width=18).grid(
                row=row, column=column + 1, sticky="ew", padx=(0, 20), pady=3
            )
        parameters.columnconfigure(1, weight=1)
        parameters.columnconfigure(3, weight=1)

        log_frame = ttk.LabelFrame(self, text="Status Log", padding=8)
        log_frame.grid(row=3, column=0, sticky="nsew")
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=14, state="disabled", wrap="word")
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scrollbar.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")

        footer = ttk.Frame(self)
        footer.grid(row=4, column=0, sticky="ew", pady=(8, 0))
        footer.columnconfigure(0, weight=1)
        ttk.Label(footer, textvariable=self.variables["status"]).grid(row=0, column=0, sticky="w")
        ttk.Progressbar(
            footer,
            variable=self.variables["progress"],
            maximum=100,
        ).grid(row=1, column=0, sticky="ew", pady=(4, 0))
        self.run_button = ttk.Button(footer, text="Run", command=self._start)
        self.run_button.grid(row=0, column=1, rowspan=2, padx=(12, 6))
        ttk.Button(footer, text="Exit", command=self.master.destroy).grid(row=0, column=2, rowspan=2)

    def _browse(self, key: str, folder: bool) -> None:
        if folder:
            selected = filedialog.askdirectory()
        else:
            selected = filedialog.askopenfilename(
                filetypes=[
                    ("Vector data", "*.gpkg *.shp *.geojson *.json"),
                    ("All files", "*.*"),
                ]
            )
        if selected:
            self.variables[key].set(selected)

    def _build_config(self) -> ProcessingConfig:
        maximum_text = str(self.variables["maximum_snap"].get()).strip()
        return ProcessingConfig(
            taz_path=str(self.variables["taz_path"].get()).strip(),
            here_links_path=str(self.variables["here_links_path"].get()).strip(),
            gstdm_links_path=str(self.variables["gstdm_links_path"].get()).strip(),
            nodes_path=str(self.variables["nodes_path"].get()).strip(),
            output_folder=str(self.variables["output_folder"].get()).strip(),
            fields=FieldMapping(
                taz_id=str(self.variables["taz_id"].get()).strip(),
                node_id=str(self.variables["node_id"].get()).strip(),
                link_from_node=str(self.variables["link_from_node"].get()).strip(),
                link_to_node=str(self.variables["link_to_node"].get()).strip(),
                link_func_class=str(self.variables["link_func_class"].get()).strip(),
            ),
            sector_count=int(self.variables["sector_count"].get()),
            target_connector_count=int(self.variables["target_count"].get()),
            minimum_connector_count=int(self.variables["minimum_count"].get()),
            minimum_angle=float(self.variables["minimum_angle"].get()),
            maximum_snap_distance=float(maximum_text) if maximum_text else None,
            blocked_major_level=int(self.variables["blocked_major_level"].get()),
            boundary_endpoint_tolerance=float(self.variables["boundary_tolerance"].get()),
        )

    def _start(self) -> None:
        try:
            config = self._build_config()
            config.validate_parameters()
            for label, value in (
                ("TAZ layer", config.taz_path),
                ("HERE Master LINKS layer", config.here_links_path),
                ("GSTDM LINKS layer", config.gstdm_links_path),
                ("GSTDM Master NODES layer", config.nodes_path),
                ("Output folder", config.output_folder),
            ):
                if not value:
                    raise ValueError(f"{label} is required.")
        except (TypeError, ValueError) as exc:
            messagebox.showerror("Invalid configuration", str(exc))
            return

        self.run_button.configure(state="disabled")
        self.variables["progress"].set(0)
        self._append_log("Processing started.")
        threading.Thread(target=self._worker, args=(config,), daemon=True).start()

    def _worker(self, config: ProcessingConfig) -> None:
        try:
            run_processing(
                config,
                progress=lambda percent, message: self.events.put(
                    ("progress", (percent, message))
                ),
                log=lambda message, level=logging.INFO: self.events.put(
                    ("log", (message, level))
                ),
            )
        except Exception as exc:
            logging.exception("Processing failed")
            self.events.put(("error", str(exc)))
        else:
            self.events.put(("done", config.output_folder))

    def _poll_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "progress":
                    percent, message = payload
                    self.variables["progress"].set(percent)
                    self.variables["status"].set(message)
                    self._append_log(message)
                elif kind == "log":
                    message, level = payload
                    prefix = "WARNING: " if level >= logging.WARNING else ""
                    self._append_log(prefix + message)
                elif kind == "error":
                    self.run_button.configure(state="normal")
                    self.variables["status"].set("Failed")
                    self._append_log(f"ERROR: {payload}")
                    messagebox.showerror("Processing failed", str(payload))
                elif kind == "done":
                    self.run_button.configure(state="normal")
                    self.variables["status"].set("Completed")
                    messagebox.showinfo("Completed", f"Outputs written to:\n{payload}")
        except queue.Empty:
            pass
        self.after(100, self._poll_events)

    def _append_log(self, message: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")


def launch() -> None:
    root = tk.Tk()
    ConnectorApp(root)
    root.mainloop()
