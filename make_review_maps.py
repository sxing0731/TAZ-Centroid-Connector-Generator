"""Create QA maps for centroid-connector review."""

from __future__ import annotations

import argparse
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.lines import Line2D
from shapely.geometry import box

from defaults import HERE_LINKS_PATH, ROOT, TAZ_PATH


def _legend() -> list[Line2D]:
    return [
        Line2D([0], [0], color="#236a8d", lw=2, label="TAZ boundary"),
        Line2D([0], [0], color="#f2c94c", lw=7, alpha=0.35, label="Sector density zone"),
        Line2D([0], [0], color="#d62828", lw=2.5, label="Connector inside TAZ"),
        Line2D([0], [0], color="#a100f2", lw=4, label="Connector outside TAZ"),
        Line2D([0], [0], color="#b8b8b8", lw=0.8, label="HERE Master LINK clipped to TAZ"),
        Line2D([0], [0], color="#006b3f", lw=2.4, label="GSTDM LINK clipped to TAZ"),
        Line2D(
            [0],
            [0],
            marker="o",
            color="w",
            markerfacecolor="#ff7f0e",
            markeredgecolor="black",
            label="Selected boundary point",
        ),
        Line2D([0], [0], marker="o", color="w", markerfacecolor="#c62828", markeredgecolor="white", label="Major node"),
        Line2D([0], [0], marker="o", color="w", markerfacecolor="#1479c9", markeredgecolor="white", label="Non-major node"),
        Line2D([0], [0], marker="*", color="w", markerfacecolor="black", markersize=12, label="Centroid"),
    ]


def choose_review_taz_ids(lines: gpd.GeoDataFrame, count: int = 5) -> list[object]:
    """Pick a compact review set with high outside length and snap distance cases."""
    if lines.empty:
        return []

    summary = (
        pd.DataFrame(lines.drop(columns="geometry"))
        .groupby("N", dropna=False)
        .agg(
            connectors=("CC_PT", "count"),
            outside_len=("OUTSIDE_LEN", "sum"),
            max_line_dist=("LINE_NODE_DIST", "max"),
            mean_density=("DENSITY", "mean"),
        )
        .reset_index()
    )
    selected: list[object] = []
    for column in ("outside_len", "max_line_dist", "connectors", "mean_density"):
        ranked = summary.sort_values(column, ascending=False)
        for taz_id in ranked["N"]:
            if taz_id not in selected:
                selected.append(taz_id)
            if len(selected) >= count:
                return selected
    return selected[:count]


def _draw_case(
    ax,
    taz: gpd.GeoDataFrame,
    links: gpd.GeoDataFrame,
    gstdm_links: gpd.GeoDataFrame,
    sectors: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
    selected: gpd.GeoDataFrame,
    nodes: gpd.GeoDataFrame,
    lines: gpd.GeoDataFrame,
    taz_id: object,
    detailed: bool = False,
) -> None:
    polygon_row = taz[taz["NEWID"] == taz_id]
    if polygon_row.empty:
        ax.set_title(f"TAZ {taz_id} not found")
        ax.set_axis_off()
        return

    polygon = polygon_row.geometry.iloc[0]
    case_lines = lines[lines["N"] == taz_id]
    bounds_source = gpd.GeoSeries(
        [polygon, *case_lines.geometry.tolist()],
        crs=taz.crs,
    )
    minx, miny, maxx, maxy = bounds_source.total_bounds
    margin = max(maxx - minx, maxy - miny) * 0.08
    bounds = (
        minx - margin,
        miny - margin,
        maxx + margin,
        maxy + margin,
    )
    view_polygon = box(*bounds)
    link_candidates = links.iloc[list(links.sindex.query(polygon, predicate="intersects"))].copy()
    if not link_candidates.empty:
        link_candidates["geometry"] = link_candidates.geometry.intersection(polygon)
        nearby_links = link_candidates[
            (~link_candidates.geometry.is_empty) & link_candidates.geometry.notna()
        ]
    else:
        nearby_links = link_candidates
    gstdm_link_candidates = gstdm_links.iloc[
        list(gstdm_links.sindex.query(polygon, predicate="intersects"))
    ].copy()
    if not gstdm_link_candidates.empty:
        gstdm_link_candidates["geometry"] = gstdm_link_candidates.geometry.intersection(polygon)
        nearby_gstdm_links = gstdm_link_candidates[
            (~gstdm_link_candidates.geometry.is_empty)
            & gstdm_link_candidates.geometry.notna()
        ]
    else:
        nearby_gstdm_links = gstdm_link_candidates
    nearby_nodes = nodes.iloc[list(nodes.sindex.query(view_polygon, predicate="intersects"))]
    case_sectors = sectors[sectors["N"] == taz_id]
    case_points = selected[selected["N"] == taz_id]
    snapped_node_ids = set(case_lines["CC_NODE"].dropna()) if "CC_NODE" in case_lines else set()
    case_centroid = centroids[centroids["N"] == taz_id]

    if not nearby_links.empty:
        nearby_links.plot(ax=ax, color="#b8b8b8", linewidth=0.45, alpha=0.8, zorder=1)
    if not nearby_gstdm_links.empty:
        nearby_gstdm_links.plot(ax=ax, color="#006b3f", linewidth=1.8, alpha=0.95, zorder=3)
    if not case_sectors.empty:
        case_sectors.plot(
            ax=ax,
            column="DENS_RANK",
            cmap="YlOrRd_r",
            alpha=0.28,
            edgecolor="#996515",
            linewidth=0.9,
            zorder=2,
        )
    polygon_row.plot(ax=ax, facecolor="#dceef8", edgecolor="#236a8d", linewidth=2, alpha=0.7, zorder=2)
    if not case_lines.empty:
        case_lines.plot(ax=ax, color="#d62828", linewidth=2.2, zorder=4)
    for row in case_lines.itertuples():
        outside = row.geometry.difference(polygon)
        if not outside.is_empty and outside.length > 1e-6:
            gpd.GeoSeries([outside], crs=lines.crs).plot(
                ax=ax,
                color="#a100f2",
                linewidth=4.2,
                zorder=5,
            )

    if not case_points.empty:
        case_points.plot(ax=ax, color="#ff7f0e", edgecolor="black", markersize=48, zorder=6)
    if not nearby_nodes.empty:
        major_nodes = nearby_nodes[nearby_nodes["MAJOR_INT"] == "Y"]
        non_major_nodes = nearby_nodes[nearby_nodes["MAJOR_INT"] != "Y"]
        if not non_major_nodes.empty:
            non_major_nodes.plot(ax=ax, color="#1479c9", edgecolor="white", marker="o", markersize=28, zorder=7)
        if not major_nodes.empty:
            major_nodes.plot(ax=ax, color="#c62828", edgecolor="white", marker="o", markersize=34, zorder=8)
        if snapped_node_ids and "N" in nearby_nodes:
            snapped_nodes = nearby_nodes[nearby_nodes["N"].isin(snapped_node_ids)]
            if not snapped_nodes.empty:
                snapped_nodes.plot(ax=ax, color="none", edgecolor="black", marker="o", markersize=78, linewidth=1.2, zorder=9)
    if not case_centroid.empty:
        case_centroid.plot(ax=ax, color="black", marker="*", markersize=130, zorder=10)

    if detailed:
        for row in case_sectors.itertuples():
            point = row.geometry.representative_point()
            ax.annotate(
                f"S{row.SECTOR_ID}\nD={row.DENSITY:.5f}\nR={row.DENS_RANK}",
                (point.x, point.y),
                ha="center",
                va="center",
                fontsize=6,
                color="#4a2f00",
                zorder=11,
            )
        for row in nearby_nodes.itertuples():
            node_id = getattr(row, "N", getattr(row, "NODE_ID", ""))
            ax.annotate(
                str(node_id),
                (row.geometry.x, row.geometry.y),
                xytext=(2, 2),
                textcoords="offset points",
                fontsize=5,
                color="#111111",
                zorder=13,
            )

    if detailed:
        for row in case_lines.itertuples():
            level = "NA" if pd.isna(row.MAJOR_LEVEL) else f"{row.MAJOR_LEVEL:g}"
            label = (
                f"{row.CC_PT}\n"
                f"major={level}, line_dist={row.LINE_NODE_DIST:.0f} ft\n"
                f"outside={row.OUTSIDE_LEN:.0f} ft"
            )
            x, y = row.geometry.coords[-1]
            ax.annotate(label, (x, y), xytext=(5, 5), textcoords="offset points", fontsize=7)

    ax.set_xlim(bounds[0], bounds[2])
    ax.set_ylim(bounds[1], bounds[3])
    ax.set_aspect("equal")
    ax.set_title(f"TAZ {taz_id}", fontsize=11, weight="bold")
    ax.set_axis_off()


def create_review_maps(
    output_folder: str | Path,
    count: int = 5,
    taz_ids: list[object] | None = None,
) -> list[Path]:
    """Create an overview image plus individual detailed review maps."""
    output = _resolve_output_folder(Path(output_folder))
    screenshots = output / "screenshots_current"
    screenshots.mkdir(parents=True, exist_ok=True)
    gpkg = output / "taz_centroid_connectors.gpkg"

    taz = gpd.read_file(TAZ_PATH, layer="taz")
    links = gpd.read_file(HERE_LINKS_PATH)
    gstdm_links = gpd.read_file(gpkg, layer="gstdm_links")
    sectors = gpd.read_file(gpkg, layer="sector_density_zones")
    centroids = gpd.read_file(gpkg, layer="taz_centroids")
    selected = gpd.read_file(gpkg, layer="final_selected_boundary_points")
    nodes = gpd.read_file(gpkg, layer="gstdm_master_nodes")
    lines = gpd.read_file(gpkg, layer="final_connector_lines")
    ids = taz_ids or choose_review_taz_ids(lines, count=count)
    legend = _legend()
    written: list[Path] = []

    if ids:
        cols = min(3, len(ids))
        rows = (len(ids) + cols - 1) // cols
        fig, axes = plt.subplots(rows, cols, figsize=(5.8 * cols, 5.4 * rows), constrained_layout=True)
        axes_list = list(getattr(axes, "flat", [axes]))
        for axis, zone in zip(axes_list, ids):
            _draw_case(axis, taz, links, gstdm_links, sectors, centroids, selected, nodes, lines, zone)
        for axis in axes_list[len(ids):]:
            axis.set_axis_off()
        fig.legend(handles=legend, loc="lower center", ncol=3, frameon=True)
        fig.suptitle("TAZ Centroid Connector QA Review", fontsize=17, weight="bold")
        overview = screenshots / "qa_review_overview.png"
        fig.savefig(overview, dpi=180, bbox_inches="tight")
        plt.close(fig)
        written.append(overview)

    for zone in ids:
        fig, ax = plt.subplots(figsize=(10, 8), constrained_layout=True)
        _draw_case(ax, taz, links, gstdm_links, sectors, centroids, selected, nodes, lines, zone, detailed=True)
        ax.legend(handles=legend, loc="lower left", fontsize=8)
        path = screenshots / f"taz_{int(float(zone))}_qa.png"
        fig.savefig(path, dpi=190, bbox_inches="tight")
        plt.close(fig)
        written.append(path)

    return written


def _resolve_output_folder(folder: Path) -> Path:
    gpkg = folder / "taz_centroid_connectors.gpkg"
    if gpkg.exists():
        return folder
    runs = sorted(
        (path for path in folder.glob("run_*") if (path / "taz_centroid_connectors.gpkg").exists()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if runs:
        return runs[0]
    return folder


def main() -> None:
    parser = argparse.ArgumentParser(description="Create QA review maps from connector outputs.")
    parser.add_argument("--output", default=str(ROOT / "output"))
    parser.add_argument("--count", type=int, default=5)
    args = parser.parse_args()
    for path in create_review_maps(args.output, count=args.count):
        print(path)


if __name__ == "__main__":
    main()
