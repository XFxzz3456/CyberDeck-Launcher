// 临时探针：验证「每次启动都清空一次」的确切语义。
// 重点：第一次丢数据，之后每次都重新失败（继续产生 broken 文件），
// 还是会累积丢失？跑完即删。

use cyberdeck_core_tests::schema::AppStateData;
use cyberdeck_core_tests::store::Store;
use std::fs;
use std::path::PathBuf;

fn mods_count(state: &AppStateData) -> usize {
    state.mods.len()
}

#[test]
fn probe_repeated_load_behaviour() {
    let base: PathBuf = std::env::temp_dir().join(format!(
        "cdl-probe-repeat-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let data_dir = base.join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let state_file = data_dir.join("launcher-state.json");

    // 构造一个「有模组、且带 modpacks 字段」的状态文件。
    let raw = r#"{
      "schemaVersion": 1,
      "gameDir": "D:/games/Cyberpunk 2077",
      "stagingDir": "staging",
      "mods": [
        {"id":"m1","name":"A","category":"x","stagingPath":"p","enabled":false,
         "installedAt":"2026-01-01T00:00:00Z","sizeBytes":0,"fileCount":0,
         "layout":"gameRoot","metadataSource":"filename"},
        {"id":"m2","name":"B","category":"x","stagingPath":"p","enabled":false,
         "installedAt":"2026-01-01T00:00:00Z","sizeBytes":0,"fileCount":0,
         "layout":"gameRoot","metadataSource":"filename"}
      ],
      "loadOrder": [],
      "modpacks": []
    }"#;
    fs::write(&state_file, raw).unwrap();

    for round in 1..=3 {
        let store = Store::load(data_dir.clone()).unwrap();
        let state = store.snapshot_data();
        let broken: Vec<String> = fs::read_dir(&data_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("broken"))
            .collect();
        let on_disk_has_modpacks =
            fs::read_to_string(&state_file).unwrap().contains("\"modpacks\"");
        println!(
            "第 {round} 轮：内存 mods={} | 磁盘 broken 数={} | 磁盘仍含 modpacks 字段={}",
            mods_count(&state),
            broken.len(),
            on_disk_has_modpacks
        );
    }

    let _ = fs::remove_dir_all(&base);
}
